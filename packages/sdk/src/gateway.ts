/**
 * Typed host-operation adapter for runtime action requests.
 * @packageDocumentation
 */
import {
  MAX_HOOK_DIAGNOSTICS,
  checkCompatibility,
  decodeCanonical,
  encodeCanonical,
  ids,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type EffectState,
  type HostFailure,
  type HookDiagnostic,
  type ExecutionLimits,
  type InvocationId,
  type OperationId,
  type RuntimeBridgeHost,
} from '@safescript/contracts';

import type { Operations, Slot, Slots } from './contract.js';
import { ABI_VERSION, freeze } from './shared.js';
import type {
  AbortSignal,
  ActionContext,
  ActionHookContext,
  BeforeActionDecision,
  CreateSafeScriptOptions,
} from './types.js';

function validBeforeActionDecision(value: unknown): BeforeActionDecision<unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.some((key) => !('value' in (descriptors[key] as PropertyDescriptor)))) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    if (keys.length === 1 && keys[0] === 'status' && record.status === 'continue') return { status: 'continue' };
    return keys.length === 2 && keys[0] === 'error' && keys[1] === 'status' && record.status === 'stop'
      ? { status: 'stop', error: record.error }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host-local association between an ergonomic handler key and its stable operation definition.
 * @internal
 */
export type OperationEntry<O extends Operations> = {
  [K in keyof O]: Readonly<{ key: K; operation: O[K] }>;
}[keyof O];

class InvocationGateway<C, O extends Operations, S extends Slots> {
  private sequence = 0;
  private attemptedCalls = 0;
  private activeCalls = 0;
  private readonly diagnostics: HookDiagnostic[] = [];

  constructor(
    private readonly options: CreateSafeScriptOptions<C, O, S>,
    private readonly operationsById: ReadonlyMap<OperationId, OperationEntry<O>>,
    private readonly context: C,
    private readonly slot: Slot<unknown, unknown>,
    private readonly signal: AbortSignal,
    private readonly invocationId: InvocationId,
    private readonly limits: ExecutionLimits,
  ) {}

  async handle(request: ActionRequest): Promise<ActionOutcome> {
    const entry = this.operationsById.get(request.operationId);
    if (!entry || !this.validEnvelope(request, entry)) return this.fail(request, 'not_performed', 'gateway_fault');
    this.sequence++;
    const decoded = this.decodeInput(request, entry);
    if (!decoded.ok) return this.fail(request, 'not_performed', 'gateway_fault');
    const context = this.actionContext(request, entry, decoded.value);
    if (this.attemptedCalls + 1 > this.limits.hostCalls || this.activeCalls + 1 > this.limits.concurrentActions)
      return this.fail(request, 'not_performed', 'gateway_fault');
    this.attemptedCalls++;
    this.activeCalls++;
    let outcome: ActionOutcome;
    try {
      outcome = await this.dispatch(request, entry, decoded.value, context);
    } finally {
      this.activeCalls--;
    }
    await this.observe(context, outcome);
    return outcome;
  }

  hookDiagnostics(): readonly HookDiagnostic[] {
    return freeze([...this.diagnostics]);
  }

  private validEnvelope(request: ActionRequest, entry: OperationEntry<O>): boolean {
    try {
      const compatible =
        checkCompatibility(
          {
            language: ABI_VERSION,
            ir: ABI_VERSION,
            abi: ABI_VERSION,
            contractId: this.options.contract.id,
            contract: this.options.contract.version,
          },
          {
            language: ABI_VERSION,
            ir: ABI_VERSION,
            abi: request.abiVersion,
            contractId: request.contractId,
            contract: request.requiredContractVersion,
          },
        ).length === 0;
      ids.parseRequest(request.requestId);
      ids.actionSite(request.actionSiteId);
      ids.module(request.source.module);
      const requiresKey = entry.operation.idempotency === 'required';
      return Boolean(
        compatible &&
        request.invocationId === this.invocationId &&
        request.requestId === ids.request(this.invocationId, this.sequence) &&
        /^[0-9a-f]{64}$/.test(request.irDigest) &&
        request.slotId === this.slot.id &&
        request.effectId === entry.operation.effect &&
        request.capabilityId === entry.operation.capability &&
        this.slot.effects.includes(request.effectId) &&
        this.slot.capabilities.includes(request.capabilityId) &&
        requiresKey === (request.idempotencyKey !== undefined) &&
        (!requiresKey || /^[0-9a-f]{64}$/.test(request.idempotencyKey ?? '')) &&
        Number.isSafeInteger(request.source.start) &&
        request.source.start >= 0 &&
        Number.isSafeInteger(request.source.end) &&
        request.source.end >= request.source.start &&
        Array.isArray(request.input) &&
        request.input.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
      );
    } catch {
      return false;
    }
  }

  private decodeInput(
    request: ActionRequest,
    entry: OperationEntry<O>,
  ): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    const decoded = decodeCanonical({ kind: 'ref', type: entry.operation.input.id }, Uint8Array.from(request.input), {
      registry: this.options.contract.registry.schemas,
    });
    return decoded.ok ? { ok: true, value: decoded.value } : { ok: false };
  }

  private actionContext(
    request: ActionRequest,
    entry: OperationEntry<O>,
    input: unknown,
  ): ActionHookContext<PropertyKey, unknown, C> {
    const fixedRequest = freeze({ ...request, source: { ...request.source }, input: [...request.input] });
    return Object.freeze({
      operation: entry.key,
      operationId: entry.operation.id,
      input,
      invocationId: request.invocationId,
      context: this.context,
      request: fixedRequest,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      signal: this.signal,
    });
  }

  private async dispatch(
    request: ActionRequest,
    entry: OperationEntry<O>,
    input: unknown,
    context: ActionHookContext<PropertyKey, unknown, C>,
  ): Promise<ActionOutcome> {
    if (this.signal.aborted) return this.fail(request, 'not_performed', 'cancelled');
    const hook = this.options.hooks?.beforeAction;
    if (hook) {
      let decision: BeforeActionDecision<unknown> | undefined;
      try {
        decision = validBeforeActionDecision(
          await (hook as unknown as (value: ActionHookContext<PropertyKey, unknown, C>) => unknown)(context),
        );
      } catch {
        decision = undefined;
      }
      if (this.signal.aborted) return this.fail(request, 'not_performed', 'cancelled');
      if (!decision) return this.fail(request, 'not_performed', 'gateway_fault');
      if (decision.status === 'stop') return this.stop(request, entry, decision.error);
    }
    if (this.signal.aborted) return this.fail(request, 'not_performed', 'cancelled');
    return this.invoke(request, entry, input, context);
  }

  private stop(request: ActionRequest, entry: OperationEntry<O>, error: unknown): ActionOutcome {
    const encoded = encodeCanonical(
      resultSchema({ kind: 'ref', type: entry.operation.output.id }, { kind: 'ref', type: entry.operation.error.id }),
      { tag: 'error', value: error },
      { registry: this.options.contract.registry.schemas },
    );
    return encoded.ok
      ? freeze({
          abiVersion: ABI_VERSION,
          requestId: request.requestId,
          result: { tag: 'completed', value: [...encoded.value] },
        })
      : this.fail(request, 'not_performed', 'gateway_fault');
  }

  private async observe(context: ActionHookContext<PropertyKey, unknown, C>, outcome: ActionOutcome): Promise<void> {
    const hook = this.options.hooks?.afterAction;
    if (!hook) return;
    try {
      await hook(Object.freeze({ ...context, outcome }) as never);
    } catch {
      if (this.diagnostics.length < MAX_HOOK_DIAGNOSTICS)
        this.diagnostics.push(
          freeze({
            code: 'hook_fault',
            point: 'after_action',
            invocationId: context.invocationId,
            requestId: context.request.requestId,
          }),
        );
    }
  }

  private async invoke(
    request: ActionRequest,
    entry: OperationEntry<O>,
    input: unknown,
    context: ActionContext<C>,
  ): Promise<ActionOutcome> {
    try {
      const outcome = await this.options.handlers[entry.key]?.(input as never, context);
      if (outcome && 'status' in outcome && outcome.status === 'failed') return this.handlerFailure(request, outcome);
      const encoded = encodeCanonical(
        resultSchema({ kind: 'ref', type: entry.operation.output.id }, { kind: 'ref', type: entry.operation.error.id }),
        outcome,
        { registry: this.options.contract.registry.schemas },
      );
      return encoded.ok
        ? freeze({
            abiVersion: ABI_VERSION,
            requestId: request.requestId,
            result: { tag: 'completed', value: [...encoded.value] },
          })
        : this.fail(request, 'unknown', 'invalid_result');
    } catch {
      return this.fail(request, 'unknown', 'handler_fault');
    }
  }

  private handlerFailure(
    request: ActionRequest,
    outcome: Readonly<{ effectState: unknown; failure: unknown }>,
  ): ActionOutcome {
    const failure = outcome.failure as Partial<HostFailure> | null;
    if (
      (outcome.effectState !== 'not_performed' && outcome.effectState !== 'unknown') ||
      ![
        'cancelled',
        'timeout',
        'unavailable',
        'handler_fault',
        'invalid_result',
        'transport_lost',
        'gateway_fault',
      ].includes(String(failure?.code)) ||
      (failure?.detail !== undefined && (typeof failure.detail !== 'string' || failure.detail.length > 160))
    )
      return this.fail(request, 'unknown', 'invalid_result');
    return freeze({
      abiVersion: ABI_VERSION,
      requestId: request.requestId,
      result: { tag: 'failed', value: { effectState: outcome.effectState, failure: outcome.failure as HostFailure } },
    });
  }

  private fail(request: ActionRequest, effectState: EffectState, code: HostFailure['code']): ActionOutcome {
    return freeze({
      abiVersion: ABI_VERSION,
      requestId: request.requestId,
      result: { tag: 'failed', value: { effectState, failure: { code } } },
    });
  }
}

/**
 * Creates the single live action adapter for one invocation.
 *
 * @remarks Every request is independently validated and consumes its sequence number before handler dispatch.
 * @internal
 */
export function createGateway<C, O extends Operations, S extends Slots>(
  options: CreateSafeScriptOptions<C, O, S>,
  operationsById: ReadonlyMap<OperationId, OperationEntry<O>>,
  context: C,
  slot: Slot<unknown, unknown>,
  signal: AbortSignal,
  invocationId: InvocationId,
  limits: ExecutionLimits,
): Readonly<{ host: RuntimeBridgeHost; hookDiagnostics: () => readonly HookDiagnostic[] }> {
  const gateway = new InvocationGateway(options, operationsById, context, slot, signal, invocationId, limits);
  return Object.freeze({
    host: Object.freeze({ handleAction: (request: ActionRequest) => gateway.handle(request) }),
    hookDiagnostics: () => gateway.hookDiagnostics(),
  });
}
