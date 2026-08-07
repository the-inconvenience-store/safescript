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
): RuntimeBridgeHost {
  let sequence = 0;
  return {
    async handleAction(request: ActionRequest): Promise<ActionOutcome> {
      const entry = operationsById.get(request.operationId);
      const fail = (effectState: EffectState, code: HostFailure['code']): ActionOutcome =>
        freeze({
          abiVersion: ABI_VERSION,
          requestId: request.requestId,
          result: { tag: 'failed', value: { effectState, failure: { code } } },
        });
      // Treat the bridge as a protocol peer, even in-process. Future process adapters must not weaken this seam.
      const validEnvelope = (() => {
        try {
          const compatible =
            checkCompatibility(
              {
                language: ABI_VERSION,
                ir: ABI_VERSION,
                abi: ABI_VERSION,
                contractId: options.contract.id,
                contract: options.contract.version,
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
          const requiresKey = entry?.operation.idempotency === 'required';
          return Boolean(
            entry &&
            compatible &&
            request.invocationId === invocationId &&
            request.requestId === ids.request(invocationId, sequence) &&
            /^[0-9a-f]{64}$/.test(request.irDigest) &&
            request.slotId === slot.id &&
            request.effectId === entry.operation.effect &&
            request.capabilityId === entry.operation.capability &&
            slot.effects.includes(request.effectId) &&
            slot.capabilities.includes(request.capabilityId) &&
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
      })();
      if (!validEnvelope || !entry) {
        return fail('not_performed', 'gateway_fault');
      }
      // A valid request attempt consumes its sequence even when policy rejects it or the handler later fails.
      sequence++;
      const decoded = decodeCanonical({ kind: 'ref', type: entry.operation.input.id }, Uint8Array.from(request.input), {
        registry: options.contract.registry.schemas,
      });
      if (!decoded.ok) return fail('not_performed', 'gateway_fault');
      let scope: Readonly<Record<string, string>>;
      try {
        const resourceScope = entry.operation.resourceScope as unknown as (
          input: unknown,
        ) => Readonly<Record<string, string>>;
        scope = freeze({ ...resourceScope(decoded.value) });
        if (Object.values(scope).some((value) => typeof value !== 'string')) {
          return fail('not_performed', 'gateway_fault');
        }
      } catch {
        return fail('not_performed', 'gateway_fault');
      }
      const actionContext: ActionContext<C> = freeze({
        invocationId: request.invocationId,
        context,
        request,
        resourceScope: scope,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        signal,
      });
      // Cancellation before dispatch proves that the external operation was not performed.
      let decision: AuthorisationDecision<E>;
      if (signal.aborted) return fail('not_performed', 'cancelled');
      try {
        decision = await options.authorise(actionContext);
      } catch {
        return fail('not_performed', 'gateway_fault');
      }
      if (decision.status === 'rejected') {
        return typeof decision.error?.code === 'string'
          ? freeze({
              abiVersion: ABI_VERSION,
              requestId: request.requestId,
              result: { tag: 'rejected', value: decision.error },
            })
          : fail('not_performed', 'gateway_fault');
      }
      if (decision.status !== 'allowed') return fail('not_performed', 'gateway_fault');
      if (signal.aborted) return fail('not_performed', 'cancelled');
      try {
        const outcome = await options.handlers[entry.key]?.(decoded.value as never, actionContext);
        if (outcome && 'status' in outcome && outcome.status === 'failed') {
          return (outcome.effectState === 'not_performed' || outcome.effectState === 'unknown') &&
            typeof outcome.failure?.code === 'string'
            ? freeze({
                abiVersion: ABI_VERSION,
                requestId: request.requestId,
                result: { tag: 'failed', value: { effectState: outcome.effectState, failure: outcome.failure } },
              })
            : fail('unknown', 'invalid_result');
        }
        const encoded = encodeCanonical(
          resultSchema(
            { kind: 'ref', type: entry.operation.output.id },
            { kind: 'ref', type: entry.operation.error.id },
          ),
          outcome,
          { registry: options.contract.registry.schemas },
        );
        return encoded.ok
          ? freeze({
              abiVersion: ABI_VERSION,
              requestId: request.requestId,
              result: { tag: 'completed', value: [...encoded.value] },
            })
          : fail('unknown', 'invalid_result');
      } catch {
        return fail('unknown', 'handler_fault');
      }
    },
  };
}
