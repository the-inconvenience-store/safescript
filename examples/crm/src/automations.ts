import { ids, type ModuleId, type OperationId } from '@safescript/contracts';
import type { SourceProgram } from '@safescript/sdk';

import type { AutomationEvent } from './contract.js';
import { scripts } from './scripts/index.js';

export interface AutomationExample {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly expectedOperations: readonly OperationId[];
  readonly input: AutomationEvent;
  readonly source: SourceProgram;
}

const sharedEvent: AutomationEvent = Object.freeze({
  workspaceId: 'workspace-acme',
  dealId: 'deal-100',
  contactId: 'contact-100',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  previousStage: 'qualified',
  stage: 'won',
  source: 'web',
  ownerId: 'owner-alex',
  currency: 'AUD',
  amountMinor: 2_500_000n,
  inactivityDays: 45n,
});

const imports = `import { Err, Ok, type Result } from "safescript:prelude"
import { type Context, type CrmActionError, type CrmAutomationEvent } from "host:api"`;

/** Wraps one readable script body in the module and handler shape required by the SDK. */
const sourceProgram = (id: string, body: string): SourceProgram => {
  const entryModule: ModuleId = ids.module(`module:example.crm/${id}`);
  return {
    entryModule,
    modules: [
      {
        id: entryModule,
        source: `${imports}

export async function run(event: CrmAutomationEvent, ctx: Context): Promise<Result<void, CrmActionError>> {
  ${body}
}`,
      },
    ],
  };
};

const operation = (name: string): OperationId => ids.operation(`operation:${name}`);
const automation = (
  id: string,
  name: string,
  description: string,
  input: AutomationEvent,
  expectedOperations: readonly OperationId[],
  body: string,
): AutomationExample => ({ id, name, description, input, expectedOperations, source: sourceProgram(id, body) });

/** Metadata and event variants are kept here; executable script bodies live in `scripts/`. */
export const AUTOMATIONS: readonly AutomationExample[] = Object.freeze([
  automation(
    'won-onboarding-task',
    'Won deal onboarding task',
    'Creates an onboarding task when a deal enters won.',
    sharedEvent,
    [operation('tasks.create')],
    scripts.wonOnboardingTask,
  ),
  automation(
    'vip-contact-tag',
    'VIP contact tag',
    'Tags the contact attached to a high-value deal.',
    sharedEvent,
    [operation('contacts.tag')],
    scripts.vipContactTag,
  ),
  automation(
    'inbound-owner-assignment',
    'Inbound owner assignment',
    'Assigns inbound leads to the sales owner.',
    { ...sharedEvent, stage: 'new', previousStage: 'none' },
    [operation('owners.assign')],
    scripts.inboundOwnerAssignment,
  ),
  automation(
    'stale-followup',
    'Stale deal follow-up',
    'Schedules a follow-up for an inactive deal.',
    { ...sharedEvent, stage: 'qualified' },
    [operation('followups.schedule')],
    scripts.staleFollowup,
  ),
  automation(
    'lost-deal-note',
    'Lost deal note',
    'Adds a durable CRM note when a deal becomes lost.',
    { ...sharedEvent, stage: 'lost' },
    [operation('notes.create')],
    scripts.lostDealNote,
  ),
  automation(
    'welcome-notification',
    'Welcome notification',
    'Sends a welcome notification for newly won work.',
    sharedEvent,
    [operation('notifications.send')],
    scripts.welcomeNotification,
  ),
  automation(
    'normalize-stage',
    'Normalize stage',
    'Normalizes an imported pending stage into qualified.',
    { ...sharedEvent, previousStage: 'new', stage: 'pending' },
    [operation('deals.stage')],
    scripts.normalizeStage,
  ),
  automation(
    'stage-audit',
    'Stage change audit',
    'Records an audit entry for a stage transition.',
    sharedEvent,
    [operation('audit.record')],
    scripts.stageAudit,
  ),
  automation(
    'high-value-escalation',
    'High-value escalation',
    'Creates a review task and alerts sales for a high-value deal.',
    sharedEvent,
    [operation('tasks.create'), operation('notifications.send')],
    scripts.highValueEscalation,
  ),
  automation(
    'nurture-sequence',
    'Nurture sequence',
    'Tags and schedules follow-up for a new inbound contact.',
    { ...sharedEvent, stage: 'new', previousStage: 'none' },
    [operation('contacts.tag'), operation('followups.schedule')],
    scripts.nurtureSequence,
  ),
]);
