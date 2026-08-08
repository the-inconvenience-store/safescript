import { ids, resultSchema, type StringSchema } from '@safescript/contracts';
import { defineContract, type ContractType } from '@safescript/sdk';

import { crmActionErrorType, crmActions, type CrmActionError } from './actions.js';

export type { CrmActionError } from './actions.js';

export interface AutomationEvent {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly contactId: string;
  readonly name: string;
  readonly email: string;
  readonly previousStage: string;
  readonly stage: string;
  readonly source: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly inactivityDays: bigint;
}

export type AutomationResult = Readonly<{ tag: 'ok'; value: null }> | Readonly<{ tag: 'error'; value: CrmActionError }>;

const string = (maxBytes = 256): StringSchema => ({ kind: 'string', maxBytes });
const eventType: ContractType<AutomationEvent> = {
  id: ids.type('type:crm.automation-event'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'workspaceId', schema: string() },
      { name: 'dealId', schema: string() },
      { name: 'contactId', schema: string() },
      { name: 'name', schema: string() },
      { name: 'email', schema: string() },
      { name: 'previousStage', schema: string() },
      { name: 'stage', schema: string() },
      { name: 'source', schema: string() },
      { name: 'ownerId', schema: string() },
      { name: 'currency', schema: string(3) },
      { name: 'amountMinor', schema: { kind: 'int64' } },
      { name: 'inactivityDays', schema: { kind: 'int64' } },
    ],
  },
};
const resultType: ContractType<AutomationResult> = {
  id: ids.type('type:crm.automation-result'),
  schema: resultSchema({ kind: 'unit' }, { kind: 'ref', type: crmActionErrorType.id }),
};
const allEffects = Object.values(crmActions).map(({ effect }) => effect);
const allCapabilities = Object.values(crmActions).map(({ capability }) => capability);

export const crmContract = defineContract({
  id: ids.contract('contract:example.crm'),
  version: { major: 1, minor: 0, patch: 0 },
  operations: crmActions,
  slots: {
    automation: {
      id: ids.slot('slot:crm.automation'),
      input: eventType,
      output: resultType,
      languageVersion: { major: 1, minor: 1 },
      effects: allEffects,
      capabilities: allCapabilities,
    },
  },
});
