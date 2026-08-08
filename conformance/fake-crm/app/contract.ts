import { ids, resultSchema, type Schema, type StringSchema } from '@safescript/contracts';
import { defineContract, type ContractType } from '@safescript/sdk';

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

export interface MutationInput {
  readonly workspaceId: string;
  readonly entityId: string;
  readonly value: string;
}

export interface MutationOutput {
  readonly id: string;
}

export type CrmActionError =
  | Readonly<{ tag: 'policy'; value: Readonly<{ code: string; detail: string }> }>
  | Readonly<{ tag: 'domain'; value: string }>;
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
const mutationInputType: ContractType<MutationInput> = {
  id: ids.type('type:crm.mutation-input'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'workspaceId', schema: string() },
      { name: 'entityId', schema: string() },
      { name: 'value', schema: string(512) },
    ],
  },
};
const mutationOutputType: ContractType<MutationOutput> = {
  id: ids.type('type:crm.mutation-output'),
  schema: { kind: 'record', fields: [{ name: 'id', schema: string() }] },
};
const errorSchema: Schema = {
  kind: 'variant',
  variants: [
    {
      tag: 'policy',
      schema: {
        kind: 'record',
        fields: [
          { name: 'code', schema: string() },
          { name: 'detail', schema: string() },
        ],
      },
    },
    { tag: 'domain', schema: string() },
  ],
};
const errorType: ContractType<CrmActionError> = { id: ids.type('type:crm.action-error'), schema: errorSchema };
const resultType: ContractType<AutomationResult> = {
  id: ids.type('type:crm.automation-result'),
  schema: resultSchema({ kind: 'unit' }, { kind: 'ref', type: errorType.id }),
};

const operation = (name: string, effectCost = 1) => ({
  id: ids.operation(`operation:${name}`),
  input: mutationInputType,
  output: mutationOutputType,
  error: errorType,
  effect: ids.effect(`effect:${name}`),
  capability: ids.capability(`capability:${name}`),
  effectCost,
  idempotency: 'required' as const,
  resourceScope: (input: MutationInput) => ({ workspaceId: input.workspaceId, entityId: input.entityId }),
});

export const crmOperations = {
  updateDealStage: operation('deals.stage'),
  addContactTag: operation('contacts.tag'),
  createTask: operation('tasks.create'),
  createNote: operation('notes.create'),
  assignOwner: operation('owners.assign'),
  sendNotification: operation('notifications.send', 2),
  scheduleFollowup: operation('followups.schedule'),
  recordAudit: operation('audit.record'),
};

const allEffects = Object.values(crmOperations).map(({ effect }) => effect);
const allCapabilities = Object.values(crmOperations).map(({ capability }) => capability);

export const crmContract = defineContract({
  id: ids.contract('contract:fixture.fake-crm'),
  version: { major: 1, minor: 0, patch: 0 },
  operations: crmOperations,
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
