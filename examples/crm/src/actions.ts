import { ids, type Schema, type StringSchema } from '@safescript/contracts';
import type { ContractType } from '@safescript/sdk';

/** The common request shape used by this small CRM's host actions. */
export interface CrmActionInput {
  readonly workspaceId: string;
  readonly entityId: string;
  readonly value: string;
}

export interface CrmActionOutput {
  readonly id: string;
}

export type CrmActionError =
  | Readonly<{ tag: 'access'; value: Readonly<{ code: string; detail: string }> }>
  | Readonly<{ tag: 'domain'; value: string }>;

const string = (maxBytes = 256): StringSchema => ({ kind: 'string', maxBytes });
const inputType: ContractType<CrmActionInput> = {
  id: ids.type('type:crm.action-input'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'workspaceId', schema: string() },
      { name: 'entityId', schema: string() },
      { name: 'value', schema: string(512) },
    ],
  },
};
const outputType: ContractType<CrmActionOutput> = {
  id: ids.type('type:crm.action-output'),
  schema: { kind: 'record', fields: [{ name: 'id', schema: string() }] },
};
const errorSchema: Schema = {
  kind: 'variant',
  variants: [
    {
      tag: 'access',
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
export const crmActionErrorType: ContractType<CrmActionError> = {
  id: ids.type('type:crm.action-error'),
  schema: errorSchema,
};

/** Defines one SDK operation and its effect, capability, and cost. */
const defineCrmAction = (name: string, effectCost = 1) => ({
  id: ids.operation(`operation:${name}`),
  input: inputType,
  output: outputType,
  error: crmActionErrorType,
  effect: ids.effect(`effect:${name}`),
  capability: ids.capability(`capability:${name}`),
  effectCost,
  idempotency: 'required' as const,
});

/** These keys become the typed methods available under `ctx` in automation scripts. */
export const crmActions = {
  updateDealStage: defineCrmAction('deals.stage'),
  addContactTag: defineCrmAction('contacts.tag'),
  createTask: defineCrmAction('tasks.create'),
  createNote: defineCrmAction('notes.create'),
  assignOwner: defineCrmAction('owners.assign'),
  sendNotification: defineCrmAction('notifications.send', 2),
  scheduleFollowup: defineCrmAction('followups.schedule'),
  recordAudit: defineCrmAction('audit.record'),
};
