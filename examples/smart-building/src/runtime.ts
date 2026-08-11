import { ids, type ExecutionLimits } from '@safescript/contracts';
import { createSafeScript } from '@safescript/sdk';

import { buildingContract, type BuildingActionInput } from './contract.js';
import { createBuildingDocumentController } from './editor/document.js';
import { BUILDING_INPUT } from './fixtures.js';

export type { AcceptedBuildingDocument } from './editor/document.js';

export interface BuildingInvocationContext {
  readonly actorId: string;
  readonly buildingIds: readonly string[];
}

export function createBuildingEditor() {
  let invocation = 0;
  const handler = (input: BuildingActionInput) => ({
    tag: 'ok' as const,
    value: { accepted: input.buildingId === 'building-riverfront' },
  });
  const safe = createSafeScript<
    BuildingInvocationContext,
    typeof buildingContract.operations,
    typeof buildingContract.slots
  >({
    contract: buildingContract,
    handlers: { setHvac: handler, setLights: handler, sendAlert: handler, recordAudit: handler },
    hooks: {
      beforeAction: ({ input, context }) =>
        context.buildingIds.includes(input.buildingId)
          ? { status: 'continue' }
          : { status: 'stop', error: 'building is not authorised for this invocation' },
    },
    createInvocationId: () => ids.invocation(`invocation:${(++invocation).toString(16).padStart(32, '0')}`),
  });
  const documents = createBuildingDocumentController(safe);
  const context: BuildingInvocationContext = Object.freeze({
    actorId: 'facilities-operator',
    buildingIds: Object.freeze(['building-riverfront']),
  });

  return {
    safe,
    ...documents,
    check() {
      return safe.check({ slot: 'automation', source: documents.current().acceptedSource });
    },
    run(limits?: Partial<ExecutionLimits>) {
      return safe.execute({
        slot: 'automation',
        program: { kind: 'source', source: documents.current().acceptedSource },
        input: BUILDING_INPUT,
        context,
        fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
        randomSeed: [11, 22, 33, 44],
        trace: true,
        ...(limits === undefined ? {} : { limits }),
      });
    },
    close: () => safe.close(),
  };
}
