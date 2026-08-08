import { ids, type ModuleId, type OperationId } from '@safescript/contracts';
import type { SourceProgram } from '@safescript/sdk';

import type { AutomationEvent } from '../app/contract.js';

export interface AutomationFixture {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly expectedOperations: readonly OperationId[];
  readonly input: AutomationEvent;
  readonly source: SourceProgram;
}

const base: AutomationEvent = Object.freeze({
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
const mutation = (entity: string, value: string) => `{
    workspaceId: event.workspaceId,
    entityId: ${entity},
    value: ${value},
  }`;
const program = (id: string, body: string): SourceProgram => {
  const entryModule: ModuleId = ids.module(`module:fake-crm/${id}`);
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
const fixture = (
  id: string,
  name: string,
  description: string,
  input: AutomationEvent,
  expectedOperations: readonly OperationId[],
  body: string,
): AutomationFixture => ({ id, name, description, input, expectedOperations, source: program(id, body) });

export const AUTOMATIONS: readonly AutomationFixture[] = Object.freeze([
  fixture(
    'won-onboarding-task',
    'Won deal onboarding task',
    'Creates an onboarding task when a deal enters won.',
    base,
    [operation('tasks.create')],
    `if (event.previousStage === "won" || event.stage !== "won" || event.currency !== "AUD" || event.amountMinor < 2_000_000) return Ok()
  const result = await ctx.tasks.create(${mutation('event.dealId', '`Onboard ${event.name}`')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'vip-contact-tag',
    'VIP contact tag',
    'Tags the contact attached to a high-value deal.',
    base,
    [operation('contacts.tag')],
    `if (event.amountMinor < 2_000_000) return Ok()
  const result = await ctx.contacts.tag(${mutation('event.contactId', '"vip"')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'inbound-owner-assignment',
    'Inbound owner assignment',
    'Assigns inbound leads to the fixture sales owner.',
    { ...base, stage: 'new', previousStage: 'none' },
    [operation('owners.assign')],
    `if (event.source !== "web") return Ok()
  const result = await ctx.owners.assign(${mutation('event.dealId', 'event.ownerId')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'stale-followup',
    'Stale deal follow-up',
    'Schedules a follow-up for an inactive deal.',
    { ...base, stage: 'qualified' },
    [operation('followups.schedule')],
    `if (event.inactivityDays < 30) return Ok()
  const result = await ctx.followups.schedule(${mutation('event.dealId', '`Follow up after ${event.inactivityDays} days`')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'lost-deal-note',
    'Lost deal note',
    'Adds a durable CRM note when a deal becomes lost.',
    { ...base, stage: 'lost' },
    [operation('notes.create')],
    `if (event.stage !== "lost") return Ok()
  const result = await ctx.notes.create(${mutation('event.dealId', '`Lost deal: ${event.name}`')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'welcome-notification',
    'Welcome notification',
    'Sends a welcome notification for newly won work.',
    base,
    [operation('notifications.send')],
    `if (event.stage !== "won") return Ok()
  const result = await ctx.notifications.send(${mutation('event.contactId', '`Welcome ${event.email}`')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'normalize-stage',
    'Normalize stage',
    'Normalizes an imported pending stage into qualified.',
    { ...base, previousStage: 'new', stage: 'pending' },
    [operation('deals.stage')],
    `if (event.stage !== "pending") return Ok()
  const result = await ctx.deals.stage(${mutation('event.dealId', '"qualified"')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'stage-audit',
    'Stage change audit',
    'Records an audit entry for a stage transition.',
    base,
    [operation('audit.record')],
    `if (event.previousStage === event.stage) return Ok()
  const result = await ctx.audit.record(${mutation('event.dealId', '`${event.previousStage} -> ${event.stage}`')})
  if (result.tag === "error") return Err(result.value)
  return Ok()`,
  ),
  fixture(
    'high-value-escalation',
    'High-value escalation',
    'Creates a review task and alerts sales for a high-value deal.',
    base,
    [operation('tasks.create'), operation('notifications.send')],
    `if (event.amountMinor < 2_000_000) return Ok()
  const task = await ctx.tasks.create(${mutation('event.dealId', '`Review ${event.name}`')})
  if (task.tag === "error") return Err(task.value)
  const notice = await ctx.notifications.send(${mutation('event.ownerId', '`High value: ${event.name}`')})
  if (notice.tag === "error") return Err(notice.value)
  return Ok()`,
  ),
  fixture(
    'nurture-sequence',
    'Nurture sequence',
    'Tags and schedules follow-up for a new inbound contact.',
    { ...base, stage: 'new', previousStage: 'none' },
    [operation('contacts.tag'), operation('followups.schedule')],
    `if (event.stage !== "new") return Ok()
  const tag = await ctx.contacts.tag(${mutation('event.contactId', '"nurture"')})
  if (tag.tag === "error") return Err(tag.value)
  const followup = await ctx.followups.schedule(${mutation('event.dealId', '"Nurture day 3"')})
  if (followup.tag === "error") return Err(followup.value)
  return Ok()`,
  ),
]);
