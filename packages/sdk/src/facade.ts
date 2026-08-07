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
  type PolicyError,
  type RuntimeBridgeHost,
  type SourceProgram as BridgeSourceProgram,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';

import type { Operations, Slot, Slots } from './contract.js';
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
  const operationEntries = Object.entries(options.contract.operations) as [keyof O, O[keyof O]][];
  const handlerKeys = Object.keys(options.handlers);
  if (
    handlerKeys.length !== operationEntries.length ||
    operationEntries.some(([key]) => typeof options.handlers[key] !== 'function') ||
    handlerKeys.some((key) => !(key in options.contract.operations))
  ) {
    throw new SdkConfigurationError('handlers must exactly match contract operations');
  }
  if (typeof options.authorise !== 'function') throw new SdkConfigurationError('authorise must be a function');
  const defaultCompileLimits = options.defaultCompileLimits;
  const defaultExecutionLimits = options.defaultExecutionLimits;
  try {
    completeLimits(STANDARD_COMPILE_LIMITS, defaultCompileLimits);
    completeLimits(STANDARD_EXECUTION_LIMITS, defaultExecutionLimits);
  } catch (error) {
    throw new SdkConfigurationError(error instanceof Error ? error.message : 'invalid SDK limits');
  }
  const bridge = options.bridge ?? createDirectRuntimeBridge();
  const createInvocationId =
    options.createInvocationId ?? (() => ids.invocation(`invocation:${randomBytes(16).toString('hex')}`));
  const operationsById = new Map(
    operationEntries.map(([key, operation]) => [operation.id, { key, operation } as OperationEntry<O>] as const),
  );
  const slotsByKey = new Map(Object.entries(options.contract.slots));
  const controllers = new Map<InvocationId, AbortController>();
  let closing = false;
  let closePromise: Promise<CloseResult> | undefined;
  const active = new Set<Promise<unknown>>();

  // Normal operational faults resolve closed result unions. Only construction-time configuration errors throw.
  const run = <T>(work: () => Promise<T>, closed: T): Promise<T> => {
    if (closing) return Promise.resolve(closed);
    let task: Promise<T>;
    try {
      task = Promise.resolve(work()).catch(() => closed);
    } catch {
      return Promise.resolve(closed);
    }
    active.add(task);
    void task.finally(() => active.delete(task));
    return task;
  };
  const slotFor = (key: PropertyKey): Slot<unknown, unknown> | undefined => slotsByKey.get(String(key));
  // Slot limits are ceilings; SDK defaults and per-call values may only reduce them.
  const compileLimits = (slot: Slot<unknown, unknown>, request?: Partial<CompileLimits>): CompileLimits =>
    completeLimits(
      slot.compileLimits ? completeLimits(STANDARD_COMPILE_LIMITS, slot.compileLimits) : STANDARD_COMPILE_LIMITS,
      defaultCompileLimits,
      request,
    );
  const executionLimits = (slot: Slot<unknown, unknown>, request?: Partial<ExecutionLimits>): ExecutionLimits =>
    completeLimits(
      slot.executionLimits
        ? completeLimits(STANDARD_EXECUTION_LIMITS, slot.executionLimits)
        : STANDARD_EXECUTION_LIMITS,
      defaultExecutionLimits,
      request,
    );
  const checkRequest = (slot: Slot<unknown, unknown>, source: SourceProgram, limits?: Partial<CompileLimits>) =>
    freeze({
      abiVersion: ABI_VERSION,
      languageVersion: slot.languageVersion,
      registry: options.contract.registry,
      slotId: slot.id,
      source: sourceProgram(source),
      limits: compileLimits(slot, limits),
    });
  const decodeOutput = (
    slot: Slot<unknown, unknown>,
    result: BridgeExecutionResult,
    invocationId: InvocationId,
  ): ExecutionResult<unknown> => {
    if (result.status === 'failed' || result.status === 'cancelled') {
      return freeze({ ...result, facts: { ...result.facts, invocationId } });
    }
    if (result.status !== 'completed') return result;
    const decoded = decodeCanonical({ kind: 'ref', type: slot.output.id }, Uint8Array.from(result.output), {
      registry: options.contract.registry.schemas,
    });
    return decoded.ok
      ? freeze({ status: 'completed', output: decoded.value, facts: { ...result.facts, invocationId } })
      : freeze({ status: 'bridge_error', error: bridgeError('execute') });
  };
  const requestFor = (
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    invocationId: InvocationId,
  ): BridgeExecuteRequest | BridgeError => {
    const input = encodeCanonical({ kind: 'ref', type: slot.input.id }, request.input, {
      registry: options.contract.registry.schemas,
    });
    if (!input.ok) return bridgeError('execute', 'invalid_request');
    try {
      // Clone every byte collection so later host mutation cannot change the logical bridge request.
      return freeze({
        abiVersion: ABI_VERSION,
        registry: options.contract.registry,
        slotId: slot.id,
        invocationId,
        program:
          request.program.kind === 'source'
            ? { kind: 'source', source: checkRequest(slot, request.program.source) }
            : { kind: 'artifact', bytes: [...request.program.bytes] },
        input: [...input.value],
        limits: executionLimits(slot, request.limits),
        ...(request.idempotencySeed === undefined ? {} : { idempotencySeed: [...request.idempotencySeed] }),
        ...(request.fixedInstant === undefined ? {} : { fixedInstant: request.fixedInstant }),
        ...(request.randomSeed === undefined ? {} : { randomSeed: [...request.randomSeed] }),
        trace: request.trace ?? 'none',
      });
    } catch {
      return bridgeError('execute', 'invalid_request');
    }
  };
  const executeBridge = async (
    slot: Slot<unknown, unknown>,
    request: ExecuteRequest<PropertyKey, unknown, C>,
    host: RuntimeBridgeHost,
    invocationId: InvocationId,
  ): Promise<ExecutionResult<unknown>> => {
    const assembled = requestFor(slot, request, invocationId);
    if ('code' in assembled) return freeze({ status: 'bridge_error', error: assembled });
    let removeAbort = (): void => undefined;
    try {
      const execution = bridge.execute(assembled, host);
      if (request.signal) {
        const cancel = (): void => {
          void bridge.cancel({ abiVersion: ABI_VERSION, invocationId }).catch(() => undefined);
        };
        if (request.signal.aborted) cancel();
        else {
          request.signal.addEventListener('abort', cancel, { once: true });
          removeAbort = () => request.signal?.removeEventListener('abort', cancel);
        }
      }
      return decodeOutput(slot, await execution, invocationId);
    } catch {
      return freeze({ status: 'bridge_error', error: bridgeError('execute') });
    } finally {
      removeAbort();
    }
  };

  return freeze({
    check(request: CheckRequest<PropertyKey>): Promise<CheckResult> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('check', 'bridge_closed') }) as CheckResult;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('check', 'invalid_request') });
        try {
          return await bridge.check(checkRequest(slot, request.source, request.limits));
        } catch {
          return freeze({ status: 'bridge_error', error: bridgeError('check') });
        }
      }, closed);
    },
    inspect(request: InspectRequest<PropertyKey>): Promise<InspectResult> {
      const closed = freeze({
        status: 'bridge_error',
        error: bridgeError('inspect', 'bridge_closed'),
      }) as InspectResult;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('inspect', 'invalid_request') });
        try {
          return await bridge.inspect({ ...checkRequest(slot, request.source, request.limits), views: request.views });
        } catch {
          return freeze({ status: 'bridge_error', error: bridgeError('inspect') });
        }
      }, closed);
    },
    execute(request: ExecuteRequest<PropertyKey, unknown, C>): Promise<ExecutionResult<unknown>> {
      const closed = freeze({
        status: 'bridge_error',
        error: bridgeError('execute', 'bridge_closed'),
      }) as ExecutionResult<unknown>;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
        let invocationId: InvocationId;
        try {
          invocationId = request.invocationId ?? createInvocationId();
          ids.invocation(invocationId);
        } catch {
          return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
        }
        // One controller joins explicit cancel(), the caller's signal, and the signal observed by host handlers.
        const controller = new AbortController();
        controllers.set(invocationId, controller);
        const abort = (): void => controller.abort();
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) controller.abort();
        try {
          return await executeBridge(
            slot,
            request,
            createGateway(options, operationsById, request.context, slot, controller.signal, invocationId),
            invocationId,
          );
        } finally {
          request.signal?.removeEventListener('abort', abort);
          controllers.delete(invocationId);
        }
      }, closed);
    },
    test(request: TestRequest<PropertyKey, unknown, unknown, O>): Promise<TestReport<unknown>> {
      const closedExecution = freeze({
        status: 'bridge_error',
        error: bridgeError('execute', 'bridge_closed'),
      }) as ExecutionResult<unknown>;
      return run(
        async () => {
          const slot = slotFor(request.slot);
          if (!slot) {
            return freeze({
              passed: false,
              mismatches: [testMismatch('slot', request.slot, undefined)],
              execution: freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') }),
            });
          }
          // Case identity supplies deterministic defaults without consulting production time, randomness, or IDs.
          const identity = hash('program', encodeUtf8(`${request.name}\0${stable(request.program)}`));
          const invocationId = request.fixed?.invocationId ?? ids.invocation(`invocation:${identity.slice(0, 32)}`);
          const scripted = createScriptedHost(options.contract, operationsById, request.actions ?? []);
          const execution = await executeBridge(
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
          );
          scripted.finish();
          compareExpectations(request.expect, execution, scripted.mismatches);
          return freeze({ passed: scripted.mismatches.length === 0, mismatches: scripted.mismatches, execution });
        },
        freeze({
          passed: false,
          mismatches: [testMismatch('facade', 'open', 'closed')],
          execution: closedExecution,
        }),
      );
    },
    cancel(invocationId: InvocationId): Promise<CancelResult> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('cancel', 'bridge_closed') }) as CancelResult;
      return run(async () => {
        controllers.get(invocationId)?.abort();
        try {
          return await bridge.cancel({ abiVersion: ABI_VERSION, invocationId });
        } catch {
          return freeze({ status: 'bridge_error', error: bridgeError('cancel') });
        }
      }, closed);
    },
    close(): Promise<CloseResult> {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      closePromise = (async () => {
        // The bridge owns cancellation semantics; facade bookkeeping is awaited after bridge closure settles.
        let result: CloseResult;
        try {
          result = await bridge.close();
        } catch {
          result = freeze({ status: 'bridge_error', error: bridgeError('close') });
        }
        await Promise.allSettled([...active]);
        return result;
      })();
      return closePromise;
    },
  }) as SafeScript<O, S, C>;
}
