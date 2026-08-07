import {
  decodeCanonical,
  encodeCanonical,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type EffectState,
  type HostFailure,
  type OperationId,
  type PolicyError,
  type RuntimeBridgeHost,
} from '@safescript/contracts';

import type { Operations, Slot, Slots } from './contract.js';
import { ABI_VERSION, freeze, stable } from './shared.js';
import type { AbortSignal, ActionContext, AuthorisationDecision, CreateSafeScriptOptions } from './types.js';

export type OperationEntry<O extends Operations> = {
  [K in keyof O]: Readonly<{ key: K; operation: O[K] }>;
}[keyof O];

export function createGateway<C, O extends Operations, S extends Slots, E extends PolicyError = PolicyError>(
  options: CreateSafeScriptOptions<C, O, S, E>,
  operationsById: ReadonlyMap<OperationId, OperationEntry<O>>,
  context: C,
  slot: Slot<unknown, unknown>,
  signal: AbortSignal,
): RuntimeBridgeHost {
  const handled = new Set<string>();
  return {
    async handleAction(request: ActionRequest): Promise<ActionOutcome> {
      const entry = operationsById.get(request.operationId);
      const fail = (effectState: EffectState, code: HostFailure['code']): ActionOutcome =>
        freeze({
          abiVersion: ABI_VERSION,
          requestId: request.requestId,
          result: { tag: 'failed', value: { effectState, failure: { code } } },
        });
      if (
        !entry ||
        request.abiVersion.major !== ABI_VERSION.major ||
        request.abiVersion.minor > ABI_VERSION.minor ||
        request.contractId !== options.contract.id ||
        stable(request.requiredContractVersion) !== stable(options.contract.version) ||
        request.slotId !== slot.id ||
        request.effectId !== entry.operation.effect ||
        request.capabilityId !== entry.operation.capability ||
        !slot.effects.includes(request.effectId) ||
        !slot.capabilities.includes(request.capabilityId) ||
        (entry.operation.idempotency === 'required') !== (request.idempotencyKey !== undefined) ||
        handled.has(request.requestId)
      ) {
        return fail('not_performed', 'gateway_fault');
      }
      handled.add(request.requestId);
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
      let decision: AuthorisationDecision<E>;
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
