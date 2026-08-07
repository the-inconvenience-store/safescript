/**
 * Current-authorisation and typed host-operation adapter for runtime action requests.
 * @packageDocumentation
 */
import {
  checkCompatibility,
  decodeCanonical,
  encodeCanonical,
  ids,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type EffectState,
  type HostFailure,
  type ExecutionLimits,
  type InvocationId,
  type OperationId,
  type PolicyError,
  type RuntimeBridgeHost,
} from '@safescript/contracts';

import type { Operations, Slot, Slots } from './contract.js';
import { ABI_VERSION, freeze } from './shared.js';
import type { AbortSignal, ActionContext, AuthorisationDecision, CreateSafeScriptOptions } from './types.js';

/**
 * Host-local association between an ergonomic handler key and its stable operation definition.
 * @internal
 */
export type OperationEntry<O extends Operations> = {
  [K in keyof O]: Readonly<{ key: K; operation: O[K] }>;
}[keyof O];

class InvocationGateway<C, O extends Operations, S extends Slots, E extends PolicyError> {
  private sequence = 0;
  private attemptedCalls = 0;
  private activeCalls = 0;

  constructor(
    private readonly options: CreateSafeScriptOptions<C, O, S, E>,
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
    const scope = this.resourceScope(entry, decoded.value);
    if (!scope) return this.fail(request, 'not_performed', 'gateway_fault');
    const context = this.actionContext(request, scope);
    if (this.signal.aborted) return this.fail(request, 'not_performed', 'cancelled');
    // Consume the attempted-call budget and reserve concurrency before current
    // authorisation. A denial is still an attempted effect and cannot be used to
    // evade the invocation budget.
    if (this.attemptedCalls + 1 > this.limits.hostCalls || this.activeCalls + 1 > this.limits.concurrentActions)
      return this.fail(request, 'not_performed', 'gateway_fault');
    this.attemptedCalls++;
    this.activeCalls++;
    try {
      const decision = await this.authorise(request, context);
      if ('result' in decision) return decision;
      if (decision.status === 'rejected') return this.rejection(request, decision);
      if (decision.status !== 'allowed') return this.fail(request, 'not_performed', 'gateway_fault');
      if (this.signal.aborted) return this.fail(request, 'not_performed', 'cancelled');
      return this.invoke(request, entry, decoded.value, context);
    } finally {
      this.activeCalls--;
    }
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

  private resourceScope(entry: OperationEntry<O>, input: unknown): Readonly<Record<string, string>> | undefined {
    try {
      const resourceScope = entry.operation.resourceScope as unknown as (
        value: unknown,
      ) => Readonly<Record<string, string>>;
      const extracted: unknown = resourceScope(input);
      if (extracted === null || typeof extracted !== 'object' || Array.isArray(extracted)) return undefined;
      const scope = freeze({ ...(extracted as Readonly<Record<string, unknown>>) });
      return Object.values(scope).every((value) => typeof value === 'string')
        ? (scope as Readonly<Record<string, string>>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private actionContext(request: ActionRequest, scope: Readonly<Record<string, string>>): ActionContext<C> {
    return freeze({
      invocationId: request.invocationId,
      context: this.context,
      request,
      resourceScope: scope,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      signal: this.signal,
    });
  }

  private async authorise(
    request: ActionRequest,
    context: ActionContext<C>,
  ): Promise<AuthorisationDecision<E> | ActionOutcome> {
    try {
      const decision: unknown = await this.options.authorise(context);
      if (decision === null || typeof decision !== 'object')
        return this.fail(request, 'not_performed', 'gateway_fault');
      const candidate = decision as Partial<AuthorisationDecision<E>>;
      if (candidate.status === 'allowed') return freeze({ status: 'allowed' });
      if (candidate.status === 'rejected') return freeze({ status: 'rejected', error: candidate.error as E });
      return this.fail(request, 'not_performed', 'gateway_fault');
    } catch {
      return this.fail(request, 'not_performed', 'gateway_fault');
    }
  }

  private rejection(
    request: ActionRequest,
    decision: Extract<AuthorisationDecision<E>, { status: 'rejected' }>,
  ): ActionOutcome {
    return typeof decision.error?.code === 'string' &&
      decision.error.code.length > 0 &&
      decision.error.code.length <= 64 &&
      (decision.error.detail === undefined ||
        (typeof decision.error.detail === 'string' && decision.error.detail.length <= 160))
      ? freeze({
          abiVersion: ABI_VERSION,
          requestId: request.requestId,
          result: { tag: 'rejected', value: decision.error },
        })
      : this.fail(request, 'not_performed', 'gateway_fault');
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
 * @remarks Every request is independently validated and authorised. The adapter consumes request sequence numbers
 * before policy evaluation so rejected requests cannot be replayed within the invocation.
 * @internal
 */
export function createGateway<C, O extends Operations, S extends Slots, E extends PolicyError = PolicyError>(
  options: CreateSafeScriptOptions<C, O, S, E>,
  operationsById: ReadonlyMap<OperationId, OperationEntry<O>>,
  context: C,
  slot: Slot<unknown, unknown>,
  signal: AbortSignal,
  invocationId: InvocationId,
  limits: ExecutionLimits,
): RuntimeBridgeHost {
  const gateway = new InvocationGateway(options, operationsById, context, slot, signal, invocationId, limits);
  return {
    handleAction: (request) => gateway.handle(request),
  };
}
