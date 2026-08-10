import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  defineSchemaRegistry,
  hash,
  ids,
  resultSchema,
  type ContractRegistry,
  type Schema,
  type StringSchema,
  type TypeDefinition,
} from '@safescript/contracts';

const encoder = new TextEncoder();
const string = (maxBytes = 128): StringSchema => ({ kind: 'string', maxBytes });

const typeIds = {
  workspace: ids.type('type:reference.workspace-id'),
  deal: ids.type('type:reference.deal-id'),
  actionOutput: ids.type('type:reference.action-output'),
  actionInput: ids.type('type:reference.action-input'),
  actionError: ids.type('type:reference.action-error'),
  event: ids.type('type:reference.event'),
  result: ids.type('type:reference.result'),
};
const ref = (type: (typeof typeIds)[keyof typeof typeIds]): Schema => ({ kind: 'ref', type });
const deal: Schema = {
  kind: 'record',
  fields: [
    { name: 'id', schema: ref(typeIds.deal) },
    { name: 'workspaceId', schema: ref(typeIds.workspace) },
    { name: 'name', schema: string() },
    { name: 'stage', schema: string() },
    {
      name: 'amount',
      schema: {
        kind: 'record',
        fields: [
          { name: 'currency', schema: string(3) },
          { name: 'minorUnits', schema: { kind: 'int64' } },
        ],
      },
    },
  ],
};
const definitions: readonly TypeDefinition[] = [
  {
    id: typeIds.workspace,
    schema: { kind: 'brand', type: typeIds.workspace, base: string() },
    fingerprint: hash('type', Uint8Array.of(1)),
  },
  {
    id: typeIds.deal,
    schema: { kind: 'brand', type: typeIds.deal, base: string() },
    fingerprint: hash('type', Uint8Array.of(2)),
  },
  {
    id: typeIds.actionOutput,
    schema: { kind: 'record', fields: [{ name: 'id', schema: string() }] },
    fingerprint: hash('type', Uint8Array.of(3)),
  },
  {
    id: typeIds.actionInput,
    schema: {
      kind: 'record',
      fields: [
        { name: 'workspaceId', schema: ref(typeIds.workspace) },
        { name: 'relatedDealId', schema: ref(typeIds.deal) },
        { name: 'title', schema: string(256) },
      ],
    },
    fingerprint: hash('type', Uint8Array.of(4)),
  },
  {
    id: typeIds.actionError,
    schema: {
      kind: 'variant',
      variants: [
        { tag: 'policy', schema: { kind: 'record', fields: [{ name: 'code', schema: string() }] } },
        { tag: 'domain', schema: string() },
      ],
    },
    fingerprint: hash('type', Uint8Array.of(5)),
  },
  {
    id: typeIds.event,
    schema: {
      kind: 'record',
      fields: [
        { name: 'before', schema: deal },
        { name: 'after', schema: deal },
      ],
    },
    fingerprint: hash('type', Uint8Array.of(6)),
  },
  {
    id: typeIds.result,
    schema: resultSchema({ kind: 'unit' }, ref(typeIds.actionError)),
    fingerprint: hash('type', Uint8Array.of(7)),
  },
];

const operations = ['tasks.create', 'notifications.send', 'http.fetch', 'profiles.enrich', 'actuator.set'] as const;
const fingerprint = (value: number) => hash('contract', Uint8Array.of(value));
const operationDefinitions = operations.map((name, index) => ({
  id: ids.operation(`operation:${name}`),
  input: typeIds.actionInput,
  output: typeIds.actionOutput,
  error: typeIds.actionError,
  effectCost: index + 1,
  fingerprint: fingerprint(30 + index),
}));
const slotId = ids.slot('slot:reference.run');

export const referenceRegistry: ContractRegistry = {
  id: ids.contract('contract:reference.integrations'),
  digest: fingerprint(20),
  schemas: defineSchemaRegistry(definitions),
  operations: operationDefinitions,
  slots: [
    {
      id: slotId,
      input: typeIds.event,
      output: typeIds.result,
      operations: operationDefinitions.map(({ id }) => id),
      compileLimits: STANDARD_COMPILE_LIMITS,
      executionLimits: STANDARD_EXECUTION_LIMITS,
      fingerprint: fingerprint(60),
    },
  ],
  definitions: [
    ...definitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
    ...operationDefinitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
    { id: slotId, fingerprint: fingerprint(60) },
  ],
};

export interface ReferenceIntegration {
  readonly name: 'walking-skeleton' | 'application-extension' | 'code-mode' | 'device-rule';
  readonly moduleId: ReturnType<typeof ids.module>;
  readonly source: string;
  readonly expectedOperations: readonly string[];
}

const imports = `import { Err, Ok, type Result } from "safescript:prelude"
import { type Context, type ReferenceActionError, type ReferenceEvent } from "host:api"`;
const actionInput = (title: string) => `{
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: ${title},
  }`;

export const walkingSkeletonReference: ReferenceIntegration = {
  name: 'walking-skeleton',
  moduleId: ids.module('module:references/walking-skeleton'),
  expectedOperations: ['operation:tasks.create'],
  source: `${imports}

export async function onDealUpdated(event: ReferenceEvent, ctx: Context): Promise<Result<void, ReferenceActionError>> {
  if (event.before.stage === "won" || event.after.stage !== "won" || event.after.amount.currency !== "AUD" || event.after.amount.minorUnits < 2_000_000) return Ok()
  const result = await ctx.tasks.create(${actionInput('`Onboard ${event.after.name}`')})
  switch (result.tag) {
    case "ok": return Ok()
    case "error": return Err(result.value)
  }
}`,
};

export const applicationExtensionReference: ReferenceIntegration = {
  name: 'application-extension',
  moduleId: ids.module('module:references/application-extension'),
  expectedOperations: ['operation:tasks.create', 'operation:notifications.send'],
  source: `${imports}

interface Stakeholder { readonly name: string; readonly email?: string; readonly reports: readonly Stakeholder[] }
function addresses(node: Stakeholder): readonly string[] {
  const own = node.email === undefined ? [] : [node.email]
  return node.reports.reduce((all, report) => [...all, ...addresses(report)], own)
}

export async function updateStakeholders(event: ReferenceEvent, ctx: Context): Promise<Result<void, ReferenceActionError>> {
  const root: Stakeholder = { name: event.after.name, email: "owner@example.test", reports: [{ name: "Finance", reports: [], email: "finance@example.test" }] }
  const task = await ctx.tasks.create(${actionInput('`Onboard ${event.after.name}`')})
  if (task.tag === "error") return Err(task.value)
  const emails = addresses(root)
  const outcomes = [
    await ctx.notifications.send(${actionInput('`Notify ${emails[0]}`')}),
    await ctx.notifications.send(${actionInput('`Notify ${emails[1]}`')}),
  ]
  for (const outcome of outcomes) {
    if (outcome.tag === "error") return Err(outcome.value)
  }
  return Ok()
}`,
};

export const codeModeReference: ReferenceIntegration = {
  name: 'code-mode',
  moduleId: ids.module('module:references/code-mode'),
  expectedOperations: ['operation:http.fetch', 'operation:profiles.enrich'],
  source: `${imports}

interface Page { readonly ids: readonly string[]; readonly next?: string }
interface Summary { readonly pages: number; readonly enriched: readonly (readonly [string, string])[] }
function parsePage(text: string): Page {
  const parsed = JSON.parse<Page>(text)
  switch (parsed.tag) {
    case "ok": return parsed.value
    case "error": return { ids: [] }
  }
}

export async function runCodeMode(event: ReferenceEvent, ctx: Context): Promise<Result<void, ReferenceActionError>> {
  const firstResponse = await ctx.http.fetch(${actionInput('`Page ${event.after.id}`')})
  if (firstResponse.tag === "error") return Err(firstResponse.value)
  const first = parsePage(firstResponse.value.id)
  const secondResponse = await ctx.http.fetch(${actionInput('`Page ${first.next ?? "end"}`')})
  if (secondResponse.tag === "error") return Err(secondResponse.value)
  const second = parsePage(secondResponse.value.id)
  const ids = [...first.ids, ...second.ids]
    .filter((id) => id.trim().length > 0)
    .map((id) => id.toUpperCase())
    .toSorted()
  const enriched = [
    await ctx.profiles.enrich(${actionInput('`Enrich ${ids[0]}`')}),
    await ctx.profiles.enrich(${actionInput('`Enrich ${ids[1]}`')}),
  ]
  for (const result of enriched) {
    if (result.tag === "error") return Err(result.value)
  }
  const summary: Summary = { pages: 2, enriched: [[ids[0], enriched[0].value.id], [ids[1], enriched[1].value.id]] }
  console.info("code-mode", summary)
  return Ok()
}`,
};

export const deviceRuleReference: ReferenceIntegration = {
  name: 'device-rule',
  moduleId: ids.module('module:references/device-rule'),
  expectedOperations: ['operation:actuator.set'],
  source: `${imports}

interface Device { readonly id: string; readonly children: readonly Device[] }
function find(node: Device, wanted: string): boolean {
  return node.id === wanted || node.children.some((child) => find(child, wanted))
}

export async function applyDeviceRule(event: ReferenceEvent, ctx: Context): Promise<Result<void, ReferenceActionError>> {
  const packet = Bytes.fromHex("0307")
  const header = packet[0]
  const flags = 3 & 7
  const root: Device = { id: "root", children: [{ id: event.after.id, children: [] }] }
  const now = Temporal.Now.instant()
  const score = Math.abs(-flags)
  const random = Math.random()
  console.info("device-rule", header, now, score, random)
  if (!find(root, event.after.id) || score < 1 || random !== random) return Ok()
  const result = await ctx.actuator.set(${actionInput('`Set ${event.after.name}`')})
  switch (result.tag) {
    case "ok": return Ok()
    case "error": return Err(result.value)
  }
}`,
};

export const referenceInput = Object.freeze({
  before: {
    id: 'deal-1',
    workspaceId: 'workspace-1',
    name: 'Acme',
    stage: 'open',
    amount: { currency: 'AUD', minorUnits: 2_000_000n },
  },
  after: {
    id: 'deal-1',
    workspaceId: 'workspace-1',
    name: 'Acme',
    stage: 'won',
    amount: { currency: 'AUD', minorUnits: 2_000_000n },
  },
});

export function referenceCheckRequest(reference: ReferenceIntegration) {
  return {
    registry: referenceRegistry,
    slotId,
    source: {
      module: reference.moduleId,
      source: [...encoder.encode(reference.source)],
    },
    limits: STANDARD_COMPILE_LIMITS,
  };
}

export const referenceTypes = Object.freeze({ ...typeIds, slotId });
