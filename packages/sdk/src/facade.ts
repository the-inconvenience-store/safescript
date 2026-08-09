/**
 * Six-method SafeScript facade and lifecycle coordination.
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';

import {
  MAX_FAILURE_DETAIL_LENGTH,
  MAX_HOOK_DIAGNOSTICS,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  decodeCanonical,
  encodeCanonical,
  hash,
  ids,
  type BridgeError,
  type CancelResult,
  type CheckResult,
  type CloseResult,
  type CompileLimits,
  type ExecuteRequest as BridgeExecuteRequest,
  type ExecutionLimits,
  type ExecutionResult as BridgeExecutionResult,
  type HookDiagnostic,
  type InspectResult,
  type InvocationId,
  type OperationId,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type SourceProgram as BridgeSourceProgram,
} from '@safescript/contracts';
import type { Contract, Operations, Slot, Slots } from './contract.js';
import { createGateway, type OperationEntry } from './gateway.js';
import { createNodeProcessRuntimeBridge } from './node-process-bridge.js';
import { ABI_VERSION, bridgeError, completeLimits, encodeUtf8, freeze, stable } from './shared.js';
import { compareExpectations, createScriptedHost, testMismatch } from './testing.js';
import {
  SdkConfigurationError,
  type AbortSignal,
  type BeforeExecuteDecision,
  type CheckRequest,
  type CreateSafeScriptOptions,
  type ExecuteRequest,
  type ExecutionResult,
  type ExecutionHookContext,
  type InspectRequest,
  type Program,
  type SafeScript,
  type SourceProgram,
  type TestReport,
  type TestRequest,
} from './types.js';

const MAX_HOOK_CODE_LENGTH = 64;

function executionProgram(request: BridgeExecuteRequest): Program {
  return request.program.kind === 'artifact'
    ? freeze({ kind: 'artifact', bytes: request.program.bytes })
    : freeze({
        kind: 'source',
        source: {
          entryModule: request.program.source.source.entry,
          modules: request.program.source.source.modules.map((module) => ({
            id: module.id,
            source: Buffer.from(module.source).toString('utf8'),
          })),
        },
      });
}

function validBeforeExecuteDecision(value: unknown): BeforeExecuteDecision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.some((key) => !('value' in (descriptors[key] as PropertyDescriptor)))) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    if (keys.length === 1 && keys[0] === 'status' && record.status === 'continue')
      return freeze({ status: 'continue' });
    const expected = record.detail === undefined ? ['code', 'status'] : ['code', 'detail', 'status'];
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      record.status !== 'rejected' ||
      typeof record.code !== 'string' ||
      [...record.code].length < 1 ||
      [...record.code].length > MAX_HOOK_CODE_LENGTH ||
      (record.detail !== undefined &&
        (typeof record.detail !== 'string' || [...record.detail].length > MAX_FAILURE_DETAIL_LENGTH))
    )
      return undefined;
    return freeze({
      status: 'rejected',
      code: record.code,
      ...(record.detail === undefined ? {} : { detail: record.detail as string }),
    });
  } catch {
    return undefined;
  }
}

function validBytes(value: readonly number[], maximum: number): boolean {
  return value.length <= maximum && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function validSignal(value: AbortSignal | undefined): boolean {
  if (value === undefined) return true;
  try {
    return (
      typeof value.aborted === 'boolean' &&
      typeof value.addEventListener === 'function' &&
      typeof value.removeEventListener === 'function'
    );
  } catch {
    return false;
  }
}

function validSourceEnvelope(request: BridgeExecuteRequest): boolean {
  if (request.program.kind !== 'source') return true;
  const { limits, source } = request.program.source;
  if (
    source.modules.length === 0 ||
    source.modules.length > limits.modules ||
    !source.modules.some((module) => module.id === source.entry)
  )
    return false;
  let totalBytes = 0;
  const moduleIds = new Set<string>();
  try {
    ids.module(source.entry);
    for (const module of source.modules) {
      ids.module(module.id);
      if (moduleIds.has(module.id) || !validBytes(module.source, limits.moduleBytes)) return false;
      moduleIds.add(module.id);
      totalBytes += module.source.length;
      if (totalBytes > limits.sourceBytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sourceProgram(source: SourceProgram): BridgeSourceProgram {
  return freeze({
    entry: source.entryModule,
    modules: source.modules.map((module) => ({ id: module.id, source: [...encodeUtf8(module.source)] })),
  });
}

function validateConfiguration<C, O extends Operations, S extends Slots>(
  options: CreateSafeScriptOptions<C, O, S>,
): void {
  const operationEntries = Object.entries(options.contract.operations) as [keyof O, O[keyof O]][];
  const handlerKeys = Object.keys(options.handlers);
  if (
    handlerKeys.length !== operationEntries.length ||
    operationEntries.some(([key]) => typeof options.handlers[key] !== 'function') ||
    handlerKeys.some((key) => !(key in options.contract.operations))
  )
    throw new SdkConfigurationError('handlers must exactly match contract operations');
  try {
    completeLimits(STANDARD_COMPILE_LIMITS, options.defaultCompileLimits);
    completeLimits(STANDARD_EXECUTION_LIMITS, options.defaultExecutionLimits);
  } catch (error) {
    throw new SdkConfigurationError(error instanceof Error ? error.message : 'invalid SDK limits');
  }
}

class RequestCodec<C, O extends Operations, S extends Slots> {
  constructor(
    private readonly contract: Contract<O, S>,
    private readonly defaultCompileLimits?: Partial<CompileLimits>,
    private readonly defaultExecutionLimits?: Partial<ExecutionLimits>,
  ) {}

  check(slot: Slot<unknown, unknown>, source: SourceProgram, limits?: Partial<CompileLimits>) {
    return freeze({
      abiVersion: ABI_VERSION,
      languageVersion: slot.languageVersion,
      registry: this.contract.registry,
      slotId: slot.id,
      source: sourceProgram(source),
      limits: this.compileLimits(slot, limits),
    });
  }

  execute(
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    invocationId: InvocationId,
  ): BridgeExecuteRequest | BridgeError {
    try {
      const limits = this.executionLimits(slot, request.limits);
      const input = encodeCanonical({ kind: 'ref', type: slot.input.id }, request.input, {
        registry: this.contract.registry.schemas,
        limits: { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxBytes: limits.maxBytes },
      });
      if (!input.ok) return bridgeError('execute', 'invalid_request');
      const trace = request.trace ?? 'none';
      const program =
        request.program.kind === 'source'
          ? { kind: 'source' as const, source: this.check(slot, request.program.source) }
          : request.program.kind === 'artifact'
            ? { kind: 'artifact' as const, bytes: [...request.program.bytes] }
            : undefined;
      const idempotencySeed = request.idempotencySeed === undefined ? undefined : [...request.idempotencySeed];
      const randomSeed = request.randomSeed === undefined ? undefined : [...request.randomSeed];
      if (
        !program ||
        !['none', 'summary', 'semantic'].includes(trace) ||
        (program.kind === 'artifact' && !validBytes(program.bytes, limits.maxBytes)) ||
        (idempotencySeed !== undefined && !validBytes(idempotencySeed, limits.maxBytes)) ||
        (randomSeed !== undefined && !validBytes(randomSeed, limits.maxBytes)) ||
        (request.fixedInstant !== undefined &&
          !encodeCanonical({ kind: 'instant' }, request.fixedInstant, {
            limits: { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxBytes: limits.maxBytes },
          }).ok)
      )
        return bridgeError('execute', 'invalid_request');
      const assembled = freeze({
        abiVersion: ABI_VERSION,
        registry: this.contract.registry,
        slotId: slot.id,
        invocationId,
        program,
        input: [...input.value],
        limits,
        ...(idempotencySeed === undefined ? {} : { idempotencySeed }),
        ...(request.fixedInstant === undefined ? {} : { fixedInstant: request.fixedInstant }),
        ...(randomSeed === undefined ? {} : { randomSeed }),
        trace,
      });
      return validSourceEnvelope(assembled) ? assembled : bridgeError('execute', 'invalid_request');
    } catch {
      return bridgeError('execute', 'invalid_request');
    }
  }

  decode(
    slot: Slot<unknown, unknown>,
    result: BridgeExecutionResult,
    invocationId: InvocationId,
  ): ExecutionResult<unknown> {
    if (result.status === 'failed' || result.status === 'cancelled')
      return freeze({ ...result, facts: { ...result.facts, invocationId } });
    if (result.status !== 'completed') return result;
    const decoded = decodeCanonical({ kind: 'ref', type: slot.output.id }, Uint8Array.from(result.output), {
      registry: this.contract.registry.schemas,
    });
    return decoded.ok
      ? freeze({ status: 'completed', output: decoded.value, facts: { ...result.facts, invocationId } })
      : freeze({ status: 'bridge_error', error: bridgeError('execute') });
  }

  hookContext(
    slot: Slot<unknown, unknown>,
    slotKey: PropertyKey,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    assembled: BridgeExecuteRequest,
    signal: AbortSignal,
  ): ExecutionHookContext<PropertyKey, unknown, C> | BridgeError {
    const input = decodeCanonical({ kind: 'ref', type: slot.input.id }, Uint8Array.from(assembled.input), {
      registry: this.contract.registry.schemas,
    });
    if (!input.ok) return bridgeError('execute', 'invalid_request');
    try {
      return Object.freeze({
        slot: slotKey,
        slotId: assembled.slotId,
        invocationId: assembled.invocationId,
        program: executionProgram(assembled),
        input: input.value,
        context: request.context,
        limits: assembled.limits,
        trace: assembled.trace,
        signal,
        ...(assembled.idempotencySeed === undefined ? {} : { idempotencySeed: assembled.idempotencySeed }),
        ...(assembled.fixedInstant === undefined ? {} : { fixedInstant: assembled.fixedInstant }),
        ...(assembled.randomSeed === undefined ? {} : { randomSeed: assembled.randomSeed }),
      });
    } catch {
      return bridgeError('execute', 'invalid_request');
    }
  }

  private compileLimits(slot: Slot<unknown, unknown>, request?: Partial<CompileLimits>): CompileLimits {
    return completeLimits(
      slot.compileLimits ? completeLimits(STANDARD_COMPILE_LIMITS, slot.compileLimits) : STANDARD_COMPILE_LIMITS,
      this.defaultCompileLimits,
      request,
    );
  }

  executionLimits(slot: Slot<unknown, unknown>, request?: Partial<ExecutionLimits>): ExecutionLimits {
    return completeLimits(
      slot.executionLimits
        ? completeLimits(STANDARD_EXECUTION_LIMITS, slot.executionLimits)
        : STANDARD_EXECUTION_LIMITS,
      this.defaultExecutionLimits,
      request,
    );
  }
}

class FacadeCoordinator<C, O extends Operations, S extends Slots> {
  private readonly bridge: RuntimeBridge;
  private readonly createInvocationId: () => InvocationId;
  private readonly operationsById: ReadonlyMap<OperationId, OperationEntry<O>>;
  private readonly slotsByKey: ReadonlyMap<string, Slot<unknown, unknown>>;
  private readonly requests: RequestCodec<C, O, S>;
  private readonly controllers = new Map<InvocationId, AbortController>();
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<CloseResult>;

  constructor(private readonly options: CreateSafeScriptOptions<C, O, S>) {
    const operationEntries = Object.entries(options.contract.operations) as [keyof O, O[keyof O]][];
    this.bridge = options.bridge ?? createNodeProcessRuntimeBridge();
    this.createInvocationId =
      options.createInvocationId ?? (() => ids.invocation(`invocation:${randomBytes(16).toString('hex')}`));
    this.operationsById = new Map(
      operationEntries.map(([key, operation]) => [operation.id, { key, operation } as OperationEntry<O>] as const),
    );
    this.slotsByKey = new Map(Object.entries(options.contract.slots));
    this.requests = new RequestCodec(options.contract, options.defaultCompileLimits, options.defaultExecutionLimits);
  }

  check(request: CheckRequest<PropertyKey>): Promise<CheckResult> {
    const closed = freeze({ status: 'bridge_error', error: bridgeError('check', 'bridge_closed') }) as CheckResult;
    return this.run(async () => {
      const slot = this.slotFor(request.slot);
      if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('check', 'invalid_request') });
      try {
        return await this.bridge.check(this.requests.check(slot, request.source, request.limits));
      } catch {
        return freeze({ status: 'bridge_error', error: bridgeError('check') });
      }
    }, closed);
  }

  inspect(request: InspectRequest<PropertyKey>): Promise<InspectResult> {
    const closed = freeze({ status: 'bridge_error', error: bridgeError('inspect', 'bridge_closed') }) as InspectResult;
    return this.run(async () => {
      const slot = this.slotFor(request.slot);
      if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('inspect', 'invalid_request') });
      try {
        return await this.bridge.inspect({
          ...this.requests.check(slot, request.source, request.limits),
          views: request.views,
          ...(request.graphLimits === undefined ? {} : { graphLimits: request.graphLimits }),
        });
      } catch {
        return freeze({ status: 'bridge_error', error: bridgeError('inspect') });
      }
    }, closed);
  }

  execute(request: ExecuteRequest<PropertyKey, unknown, C>): Promise<ExecutionResult<unknown>> {
    const closed = freeze({
      status: 'bridge_error',
      error: bridgeError('execute', 'bridge_closed'),
    }) as ExecutionResult<unknown>;
    return this.run(async () => {
      const slot = this.slotFor(request.slot);
      if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
      if (!validSignal(request.signal))
        return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
      const invocationId = this.invocation(request.invocationId);
      if (!invocationId) return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
      return this.executeInvocation(slot, request, invocationId);
    }, closed);
  }

  test(request: TestRequest<PropertyKey, unknown, unknown, O>): Promise<TestReport<unknown>> {
    const closedExecution = freeze({
      status: 'bridge_error',
      error: bridgeError('execute', 'bridge_closed'),
    }) as ExecutionResult<unknown>;
    return this.run(
      async () => this.runTest(request),
      freeze({
        passed: false,
        mismatches: [testMismatch('facade', 'open', 'closed')],
        execution: closedExecution,
      }),
    );
  }

  cancel(invocationId: InvocationId): Promise<CancelResult> {
    const closed = freeze({ status: 'bridge_error', error: bridgeError('cancel', 'bridge_closed') }) as CancelResult;
    return this.run(async () => {
      this.controllers.get(invocationId)?.abort();
      try {
        return await this.bridge.cancel({ abiVersion: ABI_VERSION, invocationId });
      } catch {
        return freeze({ status: 'bridge_error', error: bridgeError('cancel') });
      }
    }, closed);
  }

  close(): Promise<CloseResult> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private run<T>(work: () => Promise<T>, closed: T): Promise<T> {
    if (this.closing) return Promise.resolve(closed);
    let task: Promise<T>;
    try {
      task = Promise.resolve(work()).catch(() => closed);
    } catch {
      return Promise.resolve(closed);
    }
    this.active.add(task);
    void task.finally(() => this.active.delete(task));
    return task;
  }

  private slotFor(key: PropertyKey): Slot<unknown, unknown> | undefined {
    return this.slotsByKey.get(String(key));
  }

  private invocation(requested?: InvocationId): InvocationId | undefined {
    try {
      const invocationId = requested ?? this.createInvocationId();
      ids.invocation(invocationId);
      return invocationId;
    } catch {
      return undefined;
    }
  }

  private async executeInvocation(
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    invocationId: InvocationId,
  ): Promise<ExecutionResult<unknown>> {
    const controller = new AbortController();
    this.controllers.set(invocationId, controller);
    const abort = (): void => controller.abort();
    try {
      try {
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) controller.abort();
      } catch {
        return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
      }
      const assembled = this.requests.execute(slot, request, invocationId);
      if ('code' in assembled) return freeze({ status: 'bridge_error', error: assembled });
      const context = this.requests.hookContext(slot, request.slot, request, assembled, controller.signal);
      if ('code' in context) return freeze({ status: 'bridge_error', error: context });
      const gateway = createGateway(
        this.options,
        this.operationsById,
        request.context,
        slot,
        controller.signal,
        invocationId,
        assembled.limits,
      );
      let result: ExecutionResult<unknown>;
      if (this.options.hooks?.beforeExecute) {
        if (controller.signal.aborted) {
          result = freeze({ status: 'not_started', error: { code: 'cancelled' } });
        } else {
          let decision: ReturnType<typeof validBeforeExecuteDecision>;
          try {
            decision = validBeforeExecuteDecision(await this.options.hooks.beforeExecute(context as never));
          } catch {
            decision = undefined;
          }
          if (controller.signal.aborted) {
            result = freeze({ status: 'not_started', error: { code: 'cancelled' } });
          } else if (!decision) result = freeze({ status: 'not_started', error: { code: 'hook_fault' } });
          else if (decision.status === 'rejected') {
            result = freeze({
              status: 'not_started',
              error: {
                code: 'execution_rejected',
                hostCode: decision.code,
                ...(decision.detail === undefined ? {} : { detail: decision.detail }),
              },
            });
          } else {
            result = await this.executeBridge(slot, request, gateway.host, invocationId, assembled);
          }
        }
      } else {
        result = await this.executeBridge(slot, request, gateway.host, invocationId, assembled);
      }
      const actionDiagnostics = gateway.hookDiagnostics();
      if (actionDiagnostics.length)
        result = freeze({
          ...result,
          hookDiagnostics: [...(result.hookDiagnostics ?? []), ...actionDiagnostics].slice(0, MAX_HOOK_DIAGNOSTICS),
        }) as ExecutionResult<unknown>;
      return await this.afterExecute(context, result);
    } finally {
      try {
        request.signal?.removeEventListener('abort', abort);
      } catch {
        // A hostile signal must not replace the already fixed public result.
      }
      this.controllers.delete(invocationId);
    }
  }

  private async executeBridge(
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    host: RuntimeBridgeHost,
    invocationId: InvocationId,
    prepared?: BridgeExecuteRequest,
  ): Promise<ExecutionResult<unknown>> {
    const assembled = prepared ?? this.requests.execute(slot, request, invocationId);
    if ('code' in assembled) return freeze({ status: 'bridge_error', error: assembled });
    let removeAbort = (): void => undefined;
    try {
      const execution = this.bridge.execute(assembled, host);
      if (request.signal) {
        const cancel = (): void => {
          void this.bridge.cancel({ abiVersion: ABI_VERSION, invocationId }).catch(() => undefined);
        };
        if (request.signal.aborted) cancel();
        else {
          request.signal.addEventListener('abort', cancel, { once: true });
          removeAbort = () => request.signal?.removeEventListener('abort', cancel);
        }
      }
      return this.requests.decode(slot, await execution, invocationId);
    } catch {
      return freeze({ status: 'bridge_error', error: bridgeError('execute') });
    } finally {
      removeAbort();
    }
  }

  private async afterExecute(
    context: ExecutionHookContext<PropertyKey, unknown, C>,
    result: ExecutionResult<unknown>,
  ): Promise<ExecutionResult<unknown>> {
    const hook = this.options.hooks?.afterExecute;
    if (!hook) return result;
    const fixed = freeze({ ...result }) as ExecutionResult<unknown>;
    try {
      await hook(Object.freeze({ ...context, result: fixed }) as never);
      return fixed;
    } catch {
      const diagnostic: HookDiagnostic = freeze({
        code: 'hook_fault',
        point: 'after_execute',
        invocationId: context.invocationId,
      });
      return freeze({
        ...fixed,
        hookDiagnostics: [...(fixed.hookDiagnostics ?? []), diagnostic].slice(0, MAX_HOOK_DIAGNOSTICS),
      }) as ExecutionResult<unknown>;
    }
  }

  private async runTest(request: TestRequest<PropertyKey, unknown, unknown, O>): Promise<TestReport<unknown>> {
    const slot = this.slotFor(request.slot);
    if (!slot)
      return freeze({
        passed: false,
        mismatches: [testMismatch('slot', request.slot, undefined)],
        execution: freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') }),
      });
    const identity = hash('program', encodeUtf8(`${request.name}\0${stable(request.program)}`));
    const invocationId = request.fixed?.invocationId ?? ids.invocation(`invocation:${identity.slice(0, 32)}`);
    const scripted = createScriptedHost(this.options.contract, this.operationsById, request.actions ?? []);
    const decision = request.execution === undefined ? undefined : validBeforeExecuteDecision(request.execution);
    const execution =
      request.execution === undefined
        ? await this.executeBridge(
            slot,
            {
              slot: request.slot,
              program: request.program,
              input: request.input,
              context: undefined as C,
              invocationId,
              idempotencySeed: request.fixed?.idempotencySeed ?? [...encodeUtf8(identity)],
              ...(request.fixed?.instant === undefined ? {} : { fixedInstant: request.fixed.instant }),
              randomSeed: request.fixed?.randomSeed ?? [
                ...encodeUtf8(hash('program', encodeUtf8(`${identity}:random`))),
              ],
            },
            scripted.host,
            invocationId,
          )
        : decision?.status === 'rejected'
          ? freeze({
              status: 'not_started' as const,
              error: {
                code: 'execution_rejected' as const,
                hostCode: decision.code,
                ...(decision.detail === undefined ? {} : { detail: decision.detail }),
              },
            })
          : freeze({ status: 'bridge_error' as const, error: bridgeError('execute', 'invalid_request') });
    scripted.finish();
    compareExpectations(request.expect, execution, scripted.mismatches);
    return freeze({ passed: scripted.mismatches.length === 0, mismatches: scripted.mismatches, execution });
  }

  private async finishClose(): Promise<CloseResult> {
    let result: CloseResult;
    try {
      result = await this.bridge.close();
    } catch {
      result = freeze({ status: 'bridge_error', error: bridgeError('close') });
    }
    await Promise.allSettled([...this.active]);
    return result;
  }
}

/**
 * Creates the host-facing SafeScript facade and binds operation handlers once.
 *
 * @remarks A lazy supervised Node worker bridge is used unless `options.bridge` is supplied. All asynchronous methods
 * resolve stable result unions; only invalid construction throws synchronously.
 * @throws SdkConfigurationError when handlers or default limits do not match the contract.
 */
export function createSafeScript<C, O extends Operations, S extends Slots>(
  options: CreateSafeScriptOptions<C, O, S>,
): SafeScript<O, S, C> {
  validateConfiguration(options);
  const coordinator = new FacadeCoordinator(options);
  return freeze({
    check: (request: CheckRequest<PropertyKey>) => coordinator.check(request),
    inspect: (request: InspectRequest<PropertyKey>) => coordinator.inspect(request),
    execute: (request: ExecuteRequest<PropertyKey, unknown, C>) => coordinator.execute(request),
    test: (request: TestRequest<PropertyKey, unknown, unknown, O>) => coordinator.test(request),
    cancel: (invocationId: InvocationId) => coordinator.cancel(invocationId),
    close: () => coordinator.close(),
  }) as SafeScript<O, S, C>;
}
