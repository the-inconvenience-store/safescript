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

/**
 * Normative Semantic resource evidence captured through the public runtime bridge.
 *
 * @remarks Changes are release-significant: update only when intentionally changing
 * language/runtime semantics, and rerun the complete resource conformance gate.
 */
export const REFERENCE_RESOURCE_LEDGERS: readonly ReferenceResourceLedger[] = Object.freeze([
  {
    name: 'walking-skeleton',
    usage: {
      fuel: 205,
      allocations: 4,
      allocatedBytes: 79,
      peakRetainedBytes: 79,
      peakCollectionItems: 0,
      peakValueDepth: 3,
      peakValueNodes: 17,
      peakValueBytes: 80,
      peakCallDepth: 1,
      hostCalls: 1,
      peakConcurrentActions: 1,
      traceBytes: 649,
      outputBytes: 5,
    },
  },
  {
    name: 'application-extension',
    usage: {
      fuel: 640,
      allocations: 18,
      allocatedBytes: 576,
      peakRetainedBytes: 576,
      peakCollectionItems: 2,
      peakValueDepth: 3,
      peakValueNodes: 17,
      peakValueBytes: 80,
      peakCallDepth: 4,
      hostCalls: 3,
      peakConcurrentActions: 2,
      traceBytes: 1821,
      outputBytes: 5,
    },
  },
  {
    name: 'code-mode',
    usage: {
      fuel: 1013,
      allocations: 32,
      allocatedBytes: 758,
      peakRetainedBytes: 758,
      peakCollectionItems: 4,
      peakValueDepth: 3,
      peakValueNodes: 17,
      peakValueBytes: 80,
      peakCallDepth: 2,
      hostCalls: 4,
      peakConcurrentActions: 2,
      traceBytes: 3187,
      outputBytes: 5,
    },
  },
  {
    name: 'device-rule',
    usage: {
      fuel: 330,
      allocations: 9,
      allocatedBytes: 130,
      peakRetainedBytes: 130,
      peakCollectionItems: 1,
      peakValueDepth: 3,
      peakValueNodes: 17,
      peakValueBytes: 80,
      peakCallDepth: 4,
      hostCalls: 1,
      peakConcurrentActions: 1,
      traceBytes: 1874,
      outputBytes: 5,
    },
  },
] satisfies readonly ReferenceResourceLedger[]);

/** The locked standard profile consumed by the conformance release gate. */
export const REFERENCE_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 32_768,
  maxBytes: 1024 * 1024,
  fuel: 100_000,
  allocations: 10_000,
  allocatedBytes: 4 * 1024 * 1024,
  retainedBytes: 4 * 1024 * 1024,
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

/** Measures the normative workloads through an injected public adapter. */
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
          idempotencySeed: [1, 2, 3],
          fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
          randomSeed: [1, 2, 3, 4],
          trace: 'semantic',
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
