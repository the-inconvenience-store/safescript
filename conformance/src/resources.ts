import {
  encodeCanonical,
  ids,
  resultSchema,
  type ActionOutcome,
  type ExecutionLimits,
  type ExecutionUsage,
  type RuntimeBridgeFactory,
  type Schema,
} from '@safescript/contracts';

import {
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
  referenceCheckRequest,
  referenceInput,
  referenceRegistry,
  referenceTypes,
  walkingSkeletonReference,
  type ReferenceIntegration,
} from './references.js';

export type ReferenceResourceLedger = Readonly<{
  name: ReferenceIntegration['name'];
  usage: ExecutionUsage;
}>;

/** The standard profile consumed by the conformance release gate. */
export const REFERENCE_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 32_768,
  maxBytes: 1024 * 1024,
  fuel: 100_000,
  allocations: 10_000,
  allocatedBytes: 4 * 1024 * 1024,
  collectionItems: 10_000,
  callDepth: 64,
  hostCalls: 32,
  concurrentActions: 8,
  traceBytes: 128 * 1024,
  outputBytes: 1024 * 1024,
});

const references = Object.freeze([
  walkingSkeletonReference,
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
]);
const ref = (type: typeof referenceTypes.event): Schema => ({ kind: 'ref', type });

function encode(schema: Schema, value: unknown): readonly number[] {
  const encoded = encodeCanonical(schema, value, { registry: referenceRegistry.schemas });
  if (!encoded.ok) throw new Error(`invalid conformance fixture: ${encoded.failure.code}`);
  return Object.freeze([...encoded.value]);
}

/** Measures release-local reference workloads through an injected public adapter. */
export async function measureReferenceResourceLedgers(
  createBridge: RuntimeBridgeFactory,
): Promise<readonly ReferenceResourceLedger[]> {
  const input = encode(ref(referenceTypes.event), referenceInput);
  const measured: ReferenceResourceLedger[] = [];
  for (const [index, reference] of references.entries()) {
    const bridge = createBridge();
    try {
      const result = await bridge.execute(
        {
          registry: referenceRegistry,
          slotId: referenceTypes.slotId,
          invocationId: ids.invocation(`invocation:${String(index + 1).repeat(32)}`),
          program: { kind: 'source', source: referenceCheckRequest(reference) },
          input,
          limits: REFERENCE_EXECUTION_LIMITS,
          fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
          randomSeed: [1, 2, 3, 4],
          trace: true,
        },
        {
          handleAction: async (request): Promise<ActionOutcome> => {
            const id =
              request.operationId === ids.operation('operation:http.fetch')
                ? '{"ids":["sam","alex"],"next":"page-2"}'
                : String(request.operationId);
            return {
              requestId: request.requestId,
              result: {
                tag: 'completed',
                value: encode(resultSchema(ref(referenceTypes.actionOutput), ref(referenceTypes.actionError)), {
                  tag: 'ok',
                  value: { id },
                }),
              },
            };
          },
        },
      );
      if (result.status !== 'completed')
        throw new Error(`reference ${reference.name} did not complete: ${result.status}`);
      measured.push(Object.freeze({ name: reference.name, usage: result.facts.usage }));
    } finally {
      await bridge.close();
    }
  }
  return Object.freeze(measured);
}
