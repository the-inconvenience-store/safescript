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
  type CanonicalBytes,
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
  type Sha256Digest,
  type SourceProgram as BridgeSourceProgram,
} from '@safescript/contracts';
import { artifactKey } from '@safescript/engine';
import type { Contract, Operations, Slot, Slots } from './contract.js';
import { createGateway, type OperationEntry } from './gateway.js';
import { createNodeProcessRuntimeBridge } from './node-process-bridge.js';
import { bridgeError, completeLimits, encodeUtf8, freeze, stable } from './shared.js';
import { compareExpectations, createScriptedHost, testMismatch } from './testing.js';
import {
  SdkConfigurationError,
  type AbortSignal,
  type ArtifactStore,
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
const DEFAULT_ARTIFACT_STORE_TIMEOUT_MS = 1_000;
const MAX_ARTIFACT_STORE_TIMEOUT_MS = 60_000;

type ArtifactLoad =
  Readonly<{ status: 'hit'; bytes: CanonicalBytes }> | Readonly<{ status: 'miss' | 'invalid' | 'failure' }>;

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

function equalBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

class ArtifactStorage {
  private readonly controllers = new Set<AbortController>();
  private readonly loads = new Map<Sha256Digest, Promise<ArtifactLoad>>();
  private readonly stores = new Map<Sha256Digest, Promise<boolean>>();
  private closed = false;

  constructor(
    private readonly adapter: ArtifactStore,
    private readonly timeoutMs: number,
  ) {}

  load(key: Sha256Digest, signal: AbortSignal): Promise<ArtifactLoad> {
    const existing = this.loads.get(key);
    if (existing) return this.wait(existing, signal, { status: 'failure' });
    const operation = this.bounded<ArtifactLoad>(
      async (operationSignal) => {
        const value = await this.adapter.load(key, { signal: operationSignal });
        if (value === undefined) return { status: 'miss' } as const;
        let bytes: number[];
        try {
          bytes = [...value];
        } catch {
          return { status: 'invalid' } as const;
        }
        return validBytes(bytes, STANDARD_EXECUTION_LIMITS.maxBytes)
          ? ({ status: 'hit', bytes: freeze(bytes) } as const)
          : ({ status: 'invalid' } as const);
      },
      { status: 'failure' } as const,
    ).finally(() => this.loads.delete(key));
    this.loads.set(key, operation);
    return this.wait(operation, signal, { status: 'failure' });
  }

  store(key: Sha256Digest, bytes: CanonicalBytes): Promise<boolean> {
    const existing = this.stores.get(key);
    if (existing) return existing;
    const operation = this.bounded(async (signal) => {
      await this.adapter.store(key, bytes, { signal });
      return true;
    }, false).finally(() => this.stores.delete(key));
    this.stores.set(key, operation);
    return operation;
  }

  remove(key: Sha256Digest): Promise<boolean> {
    if (!this.adapter.remove) return Promise.resolve(false);
    return this.bounded(async (signal) => {
      await this.adapter.remove?.(key, { signal });
      return true;
    }, false);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }

  private async bounded<T>(work: (signal: globalThis.AbortSignal) => Promise<T>, fallback: T): Promise<T> {
    if (this.closed) return fallback;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(fallback);
      }, this.timeoutMs);
    });
    const operation = Promise.resolve()
      .then(() => work(controller.signal))
      .catch(() => fallback);
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private wait<T>(operation: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
    if (signal.aborted) return Promise.resolve(fallback);
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = (): void => finish(fallback);
      signal.addEventListener('abort', abort, { once: true });
      void operation.then(finish, () => finish(fallback));
    });
  }
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
  const store = options.artifactStore;
  const timeout = options.artifactStoreTimeoutMs;
  if (
    (store !== undefined &&
      (store === null ||
        typeof store !== 'object' ||
        typeof store.load !== 'function' ||
        typeof store.store !== 'function' ||
        (store.remove !== undefined && typeof store.remove !== 'function'))) ||
    (timeout !== undefined &&
      (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_ARTIFACT_STORE_TIMEOUT_MS)) ||
    (store === undefined && timeout !== undefined)
  )
    throw new SdkConfigurationError('invalid artifact store configuration');
}

class RequestCodec<C, O extends Operations, S extends Slots> {
  constructor(
    private readonly contract: Contract<O, S>,
    private readonly defaultCompileLimits?: Partial<CompileLimits>,
    private readonly defaultExecutionLimits?: Partial<ExecutionLimits>,
  ) {}

  check(
    slot: Slot<unknown, unknown>,
    source: SourceProgram,
    limits?: Partial<CompileLimits>,
    includeArtifact = false,
    cachedArtifact?: CanonicalBytes,
  ) {
    return freeze({
      registry: this.contract.registry,
      slotId: slot.id,
      source: sourceProgram(source),
      limits: this.compileLimits(slot, limits),
      includeArtifact,
      ...(cachedArtifact === undefined ? {} : { cachedArtifact }),
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
      const trace = request.trace ?? false;
      const program =
        request.program.kind === 'source'
          ? {
              kind: 'source' as const,
              source: this.check(slot, request.program.source, undefined, request.includeArtifact ?? false),
            }
          : request.program.kind === 'artifact'
            ? { kind: 'artifact' as const, bytes: [...request.program.bytes] }
            : undefined;
      const idempotencySeed = request.idempotencySeed === undefined ? undefined : [...request.idempotencySeed];
      const randomSeed = request.randomSeed === undefined ? undefined : [...request.randomSeed];
      if (
        !program ||
        typeof trace !== 'boolean' ||
        (request.includeArtifact !== undefined && typeof request.includeArtifact !== 'boolean') ||
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
  private readonly artifactStorage: ArtifactStorage | undefined;
  private readonly knownArtifactKeys = new Set<Sha256Digest>();
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
    this.artifactStorage = options.artifactStore
      ? new ArtifactStorage(options.artifactStore, options.artifactStoreTimeoutMs ?? DEFAULT_ARTIFACT_STORE_TIMEOUT_MS)
      : undefined;
  }

  check(request: CheckRequest<PropertyKey>): Promise<CheckResult> {
    const closed = freeze({ status: 'bridge_error', error: bridgeError('check', 'bridge_closed') }) as CheckResult;
    return this.run(async () => {
      const slot = this.slotFor(request.slot);
      if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('check', 'invalid_request') });
      try {
        if (request.includeArtifact !== undefined && typeof request.includeArtifact !== 'boolean')
          return freeze({ status: 'bridge_error', error: bridgeError('check', 'invalid_request') });
        const assembled = this.requests.check(slot, request.source, request.limits, request.includeArtifact ?? false);
        const result = await this.bridge.check(assembled);
        if (result.status === 'bridge_error') this.knownArtifactKeys.clear();
        const key = result.status === 'accepted' && this.artifactStorage ? artifactKey(assembled) : undefined;
        if (key) this.knownArtifactKeys.add(key);
        return result;
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
        if (request.includeArtifact !== undefined && typeof request.includeArtifact !== 'boolean')
          return freeze({ status: 'bridge_error', error: bridgeError('inspect', 'invalid_request') });
        const assembled = {
          ...this.requests.check(slot, request.source, request.limits, request.includeArtifact ?? false),
          views: request.views,
          ...(request.graphLimits === undefined ? {} : { graphLimits: request.graphLimits }),
        };
        const result = await this.bridge.inspect(assembled);
        if (result.status === 'bridge_error') this.knownArtifactKeys.clear();
        const key = result.status === 'accepted' && this.artifactStorage ? artifactKey(assembled) : undefined;
        if (key) this.knownArtifactKeys.add(key);
        return result;
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
        return await this.bridge.cancel({ invocationId });
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
            result = await this.executeBridge(slot, request, gateway.host, invocationId, assembled, controller.signal);
          }
        }
      } else {
        result = await this.executeBridge(slot, request, gateway.host, invocationId, assembled, controller.signal);
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
    storageSignal?: AbortSignal,
    useArtifactStore = true,
  ): Promise<ExecutionResult<unknown>> {
    const assembled = prepared ?? this.requests.execute(slot, request, invocationId);
    if ('code' in assembled) return freeze({ status: 'bridge_error', error: assembled });
    let removeAbort = (): void => undefined;
    try {
      const storage = useArtifactStore ? this.artifactStorage : undefined;
      let bridgeRequest = assembled;
      let key: Sha256Digest | undefined;
      let loaded: ArtifactLoad | undefined;
      if (storage && storageSignal && assembled.program.kind === 'source') {
        key = artifactKey(assembled.program.source);
        if (key && this.knownArtifactKeys.has(key)) {
          bridgeRequest = freeze({
            ...assembled,
            program: {
              kind: 'source' as const,
              source: { ...assembled.program.source, includeArtifact: request.includeArtifact ?? false },
            },
          });
        } else if (key) {
          loaded = await storage.load(key, storageSignal);
          if (loaded.status === 'invalid') await storage.remove(key);
          bridgeRequest = freeze({
            ...assembled,
            program: {
              kind: 'source' as const,
              source: {
                ...assembled.program.source,
                includeArtifact: true,
                ...(loaded.status === 'hit' ? { cachedArtifact: loaded.bytes } : {}),
              },
            },
          });
        }
      }
      if (storageSignal?.aborted) return freeze({ status: 'not_started', error: { code: 'cancelled' } });
      const execution = this.bridge.execute(bridgeRequest, host);
      if (request.signal) {
        const cancel = (): void => {
          void this.bridge.cancel({ invocationId }).catch(() => undefined);
        };
        if (request.signal.aborted) cancel();
        else {
          request.signal.addEventListener('abort', cancel, { once: true });
          removeAbort = () => request.signal?.removeEventListener('abort', cancel);
        }
      }
      let bridgeResult = await execution;
      if (storage && key && loaded && bridgeResult.status !== 'not_started' && bridgeResult.status !== 'bridge_error') {
        const preparation = bridgeResult.facts.preparation;
        if (preparation.kind === 'source' && preparation.artifact) {
          const same = loaded.status === 'hit' && equalBytes(loaded.bytes, preparation.artifact);
          if (loaded.status === 'hit' && !same) await storage.remove(key);
          if (!same && loaded.status !== 'failure') await storage.store(key, preparation.artifact);
          this.knownArtifactKeys.add(key);
          if (request.includeArtifact !== true) {
            const publicPreparation = {
              kind: preparation.kind,
              summary: preparation.summary,
              provenance: preparation.provenance,
              usage: preparation.usage,
              diagnostics: preparation.diagnostics,
            } as const;
            bridgeResult = freeze({
              ...bridgeResult,
              facts: { ...bridgeResult.facts, preparation: publicPreparation },
            }) as BridgeExecutionResult;
          }
        }
      }
      if (bridgeResult.status === 'bridge_error') this.knownArtifactKeys.clear();
      return this.requests.decode(slot, bridgeResult, invocationId);
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
            undefined,
            undefined,
            false,
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
    this.artifactStorage?.close();
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
