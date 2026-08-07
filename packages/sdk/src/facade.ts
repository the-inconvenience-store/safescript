/**
 * Six-method SafeScript facade and lifecycle coordination.
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';

import {
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
  type InspectResult,
  type InvocationId,
  type OperationId,
  type PolicyError,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type SourceProgram as BridgeSourceProgram,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';

import type { Contract, Operations, Slot, Slots } from './contract.js';
import { createGateway, type OperationEntry } from './gateway.js';
import { ABI_VERSION, bridgeError, completeLimits, encodeUtf8, freeze, stable } from './shared.js';
import { compareExpectations, createScriptedHost, testMismatch } from './testing.js';
import {
  SdkConfigurationError,
  type CheckRequest,
  type CreateSafeScriptOptions,
  type ExecuteRequest,
  type ExecutionResult,
  type InspectRequest,
  type SafeScript,
  type SourceProgram,
  type TestReport,
  type TestRequest,
} from './types.js';

function sourceProgram(source: SourceProgram): BridgeSourceProgram {
  return freeze({
    entry: source.entryModule,
    modules: source.modules.map((module) => ({ id: module.id, source: [...encodeUtf8(module.source)] })),
  });
}

function validateConfiguration<C, O extends Operations, S extends Slots, E extends PolicyError>(
  options: CreateSafeScriptOptions<C, O, S, E>,
): void {
  const operationEntries = Object.entries(options.contract.operations) as [keyof O, O[keyof O]][];
  const handlerKeys = Object.keys(options.handlers);
  if (
    handlerKeys.length !== operationEntries.length ||
    operationEntries.some(([key]) => typeof options.handlers[key] !== 'function') ||
    handlerKeys.some((key) => !(key in options.contract.operations))
  )
    throw new SdkConfigurationError('handlers must exactly match contract operations');
  if (typeof options.authorise !== 'function') throw new SdkConfigurationError('authorise must be a function');
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
    const input = encodeCanonical({ kind: 'ref', type: slot.input.id }, request.input, {
      registry: this.contract.registry.schemas,
    });
    if (!input.ok) return bridgeError('execute', 'invalid_request');
    try {
      return freeze({
        abiVersion: ABI_VERSION,
        registry: this.contract.registry,
        slotId: slot.id,
        invocationId,
        program:
          request.program.kind === 'source'
            ? { kind: 'source', source: this.check(slot, request.program.source) }
            : { kind: 'artifact', bytes: [...request.program.bytes] },
        input: [...input.value],
        limits: this.executionLimits(slot, request.limits),
        ...(request.idempotencySeed === undefined ? {} : { idempotencySeed: [...request.idempotencySeed] }),
        ...(request.fixedInstant === undefined ? {} : { fixedInstant: request.fixedInstant }),
        ...(request.randomSeed === undefined ? {} : { randomSeed: [...request.randomSeed] }),
        trace: request.trace ?? 'none',
      });
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

class FacadeCoordinator<C, O extends Operations, S extends Slots, E extends PolicyError> {
  private readonly bridge: RuntimeBridge;
  private readonly createInvocationId: () => InvocationId;
  private readonly operationsById: ReadonlyMap<OperationId, OperationEntry<O>>;
  private readonly slotsByKey: ReadonlyMap<string, Slot<unknown, unknown>>;
  private readonly requests: RequestCodec<C, O, S>;
  private readonly controllers = new Map<InvocationId, AbortController>();
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<CloseResult>;

  constructor(private readonly options: CreateSafeScriptOptions<C, O, S, E>) {
    const operationEntries = Object.entries(options.contract.operations) as [keyof O, O[keyof O]][];
    this.bridge = options.bridge ?? createDirectRuntimeBridge();
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
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    try {
      return await this.executeBridge(
        slot,
        request,
        createGateway(
          this.options,
          this.operationsById,
          request.context,
          slot,
          controller.signal,
          invocationId,
          this.requests.executionLimits(slot, request.limits),
        ),
        invocationId,
      );
    } finally {
      request.signal?.removeEventListener('abort', abort);
      this.controllers.delete(invocationId);
    }
  }

  private async executeBridge(
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    host: RuntimeBridgeHost,
    invocationId: InvocationId,
  ): Promise<ExecutionResult<unknown>> {
    const assembled = this.requests.execute(slot, request, invocationId);
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
    const execution = await this.executeBridge(
      slot,
      {
        slot: request.slot,
        program: request.program,
        input: request.input,
        context: undefined as C,
        invocationId,
        idempotencySeed: request.fixed?.idempotencySeed ?? [...encodeUtf8(identity)],
        ...(request.fixed?.instant === undefined ? {} : { fixedInstant: request.fixed.instant }),
        randomSeed: request.fixed?.randomSeed ?? [...encodeUtf8(hash('program', encodeUtf8(`${identity}:random`)))],
      },
      scripted.host,
      invocationId,
    );
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
 * Creates the host-facing SafeScript facade and binds current authorisation and operation handlers once.
 *
 * @remarks The direct in-process bridge is used unless `options.bridge` is supplied. All asynchronous methods resolve
 * stable result unions; only invalid construction throws synchronously.
 * @throws SdkConfigurationError when handlers, authorisation, or default limits do not match the contract.
 */
export function createSafeScript<C, O extends Operations, S extends Slots, E extends PolicyError = PolicyError>(
  options: CreateSafeScriptOptions<C, O, S, E>,
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
