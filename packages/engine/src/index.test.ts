import { describe, expect, it } from 'bun:test';

import {
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_SEMANTIC_GRAPH_LIMITS,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type ContractRegistry,
  type ExecuteRequest,
  type InspectResult,
  type InspectViewRequest,
  type SemanticEditId,
  type SemanticEditCapabilityManifest,
  type SemanticGraph,
  type SemanticNodeId,
  type Schema,
  type StringSchema,
  type TypeDefinition,
} from '@safescript/contracts';

import { artifactKey, createDirectRuntimeBridge } from './index.js';
import { compileProgram } from './compiler.js';
import { EditableSourceDocument, applySourceTransformations } from './source-transform.js';
import { applyPrimitiveSemanticEdits, primitiveEditCoverage } from './semantic-primitives.js';

const source = `import { Err, Ok, type Result } from "safescript:prelude"
import {
  type Context,
  type DealUpdated,
  type TaskError,
} from "host:api"

export async function onDealUpdated(
  event: DealUpdated,
  ctx: Context,
): Promise<Result<void, TaskError>> {
  if (
    event.before.stage === "won" ||
    event.after.stage !== "won" ||
    event.after.amount.currency !== "AUD" ||
    event.after.amount.minorUnits < 2_000_000
  ) {
    return Ok()
  }

  const result = await ctx.tasks.create({
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`Onboard \${event.after.name}\`,
  })

  switch (result.tag) {
    case "ok":
      return Ok()
    case "error":
      return Err(result.value)
  }
}
`;

const typeIds = {
  workspace: ids.type('type:crm.workspace-id'),
  deal: ids.type('type:crm.deal-id'),
  task: ids.type('type:tasks.task'),
  taskInput: ids.type('type:tasks.create-input'),
  taskError: ids.type('type:tasks.error'),
  event: ids.type('type:crm.deal-updated'),
  result: ids.type('type:crm.handler-result'),
};

const ref = (type: typeof typeIds.workspace): Schema => ({ kind: 'ref', type });
const string = (maxBytes = 100): StringSchema => ({ kind: 'string', maxBytes });
const money: Schema = {
  kind: 'record',
  fields: [
    { name: 'currency', schema: string(3) },
    { name: 'minorUnits', schema: { kind: 'int64' } },
  ],
};
const deal: Schema = {
  kind: 'record',
  fields: [
    { name: 'id', schema: ref(typeIds.deal) },
    { name: 'workspaceId', schema: ref(typeIds.workspace) },
    { name: 'name', schema: string() },
    { name: 'stage', schema: string() },
    { name: 'amount', schema: money },
  ],
};
const definitions: TypeDefinition[] = [
  {
    id: typeIds.workspace,
    schema: { kind: 'brand', type: typeIds.workspace, base: string() },
    fingerprint: hash('type', new Uint8Array([1])),
  },
  {
    id: typeIds.deal,
    schema: { kind: 'brand', type: typeIds.deal, base: string() },
    fingerprint: hash('type', new Uint8Array([2])),
  },
  {
    id: typeIds.task,
    schema: { kind: 'record', fields: [{ name: 'id', schema: string() }] },
    fingerprint: hash('type', new Uint8Array([3])),
  },
  {
    id: typeIds.taskInput,
    schema: {
      kind: 'record',
      fields: [
        { name: 'workspaceId', schema: ref(typeIds.workspace) },
        { name: 'relatedDealId', schema: ref(typeIds.deal) },
        { name: 'title', schema: string(108) },
      ],
    },
    fingerprint: hash('type', new Uint8Array([4])),
  },
  {
    id: typeIds.taskError,
    schema: {
      kind: 'variant',
      variants: [
        { tag: 'policy', schema: { kind: 'record', fields: [{ name: 'code', schema: string() }] } },
        { tag: 'domain', schema: string() },
      ],
    },
    fingerprint: hash('type', new Uint8Array([5])),
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
    fingerprint: hash('type', new Uint8Array([6])),
  },
  {
    id: typeIds.result,
    schema: resultSchema({ kind: 'unit' }, ref(typeIds.taskError)),
    fingerprint: hash('type', new Uint8Array([7])),
  },
];
const operation = ids.operation('operation:tasks.create');
const slot = ids.slot('slot:deal.updated');
const fingerprint = (value: number) => hash('contract', Uint8Array.of(value));
const registry: ContractRegistry = {
  id: ids.contract('contract:crm'),
  digest: fingerprint(20),
  schemas: defineSchemaRegistry(definitions),
  operations: [
    {
      id: operation,
      input: typeIds.taskInput,
      output: typeIds.task,
      error: typeIds.taskError,
      effectCost: 10,
      fingerprint: fingerprint(23),
    },
  ],
  slots: [
    {
      id: slot,
      input: typeIds.event,
      output: typeIds.result,
      operations: [operation],
      compileLimits: STANDARD_COMPILE_LIMITS,
      executionLimits: STANDARD_EXECUTION_LIMITS,
      fingerprint: fingerprint(24),
    },
  ],
  definitions: [
    ...definitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
    { id: operation, fingerprint: fingerprint(23) },
    { id: slot, fingerprint: fingerprint(24) },
  ],
};
const moduleId = ids.module('module:crm/handler');
const checkRequest = {
  registry,
  slotId: slot,
  source: { module: moduleId, source: [...new TextEncoder().encode(source)] },
  limits: STANDARD_COMPILE_LIMITS,
} as const;

const semanticGraphView = (
  limits = STANDARD_SEMANTIC_GRAPH_LIMITS,
): Extract<InspectViewRequest, { kind: 'semantic_graph' }> => ({
  kind: 'semantic_graph',
  schema: SEMANTIC_GRAPH_SCHEMA,
  limits,
});

const semanticCapabilitiesView = (): Extract<InspectViewRequest, { kind: 'semantic_edit_capabilities' }> => ({
  kind: 'semantic_edit_capabilities',
  schema: SEMANTIC_EDIT_SCHEMA,
  scope: 'all',
  limits: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
});

function semanticGraphBytes(result: Extract<InspectResult, { status: 'accepted' }>): readonly number[] {
  const view = result.views.find((candidate) => candidate.kind === 'semantic_graph');
  if (!view || view.status !== 'accepted') throw new Error('semantic graph view was not accepted');
  return view.bytes;
}

function encoded(schema: Schema, value: unknown): readonly number[] {
  const result = encodeCanonical(schema, value, { registry: registry.schemas });
  if (!result.ok) throw new Error(result.failure.code);
  return [...result.value];
}

describe('semantic transformation final checking', () => {
  it('runs the complete transformed source through the real restricted compiler and maps its rejection', () => {
    const selectedSlot = registry.slots[0];
    if (!selectedSlot) throw new Error('test registry requires a slot');
    const selected = 'Ok()';
    const utf16Start = source.indexOf(selected);
    const start = new TextEncoder().encode(source.slice(0, utf16Start)).length;
    const result = applySourceTransformations(
      new EditableSourceDocument(checkRequest.source),
      [
        {
          kind: 'replace',
          editId: 'edit:real-check' as SemanticEditId,
          targets: [`semantic-node:${'4'.repeat(64)}` as SemanticNodeId],
          range: { start, end: start + selected.length },
          content: { bytes: new TextEncoder().encode('Ok(]'), origin: 'fragment' },
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
      (candidate) => {
        const checked = compileProgram(
          new TextDecoder().decode(Uint8Array.from(candidate.source)),
          moduleId,
          registry,
          selectedSlot,
        );
        return checked.ok
          ? { ok: true }
          : {
              ok: false,
              diagnostics: [
                { message: checked.failure.message, start: checked.failure.start, end: checked.failure.end },
              ],
            };
      },
    );
    expect(result.status).toBe('rejected');
    expect(result).toMatchObject({
      reason: 'candidate_rejected',
      diagnostics: [{ location: { kind: 'fragment', editId: 'edit:real-check' } }],
    });
    expect('source' in result).toBe(false);
  });
});

function event(stage = 'open', minorUnits = 2_000_000n) {
  const makeDeal = (value: string) => ({
    id: 'deal-1',
    workspaceId: 'workspace-1',
    name: 'Acme',
    stage: value,
    amount: { currency: 'AUD', minorUnits },
  });
  return { before: makeDeal(stage), after: makeDeal('won') };
}

function executeRequest(
  program: ExecuteRequest['program'],
  input = event(),
  limits = STANDARD_EXECUTION_LIMITS,
): ExecuteRequest {
  return {
    registry,
    slotId: slot,
    invocationId: ids.invocation(`invocation:${crypto.randomUUID().replaceAll('-', '')}`),
    program,
    input: encoded(ref(typeIds.event), input),
    limits,
    trace: false,
  };
}

function checkWithSource(value: string) {
  return {
    ...checkRequest,
    source: { module: moduleId, source: [...new TextEncoder().encode(value)] },
  };
}

const unreachableHost = {
  handleAction: async (): Promise<never> => {
    throw new Error('unreachable');
  },
};

describe('direct RuntimeBridge walking skeleton', () => {
  it('derives artifact-store keys from compilation semantics but not output selection', () => {
    const key = artifactKey(checkRequest);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(artifactKey({ ...checkRequest, includeArtifact: true })).toBe(key);
    expect(artifactKey({ ...checkRequest, limits: { ...checkRequest.limits, syntaxNodes: 1 } })).not.toBe(key);
    expect(artifactKey(checkWithSource(source.replace('2_000_000', '1_000_000')))).not.toBe(key);
    expect(
      artifactKey({ ...checkRequest, registry: { ...registry, digest: hash('contract', Uint8Array.of(99)) } }),
    ).not.toBe(key);
  });

  it('derives behavior from checked source instead of fixture constants', async () => {
    const alternateSource = source.replace('2_000_000', '1_000_000').replace('Onboard ', 'Review ');
    const alternateCheck = {
      ...checkRequest,
      source: {
        module: moduleId,
        source: [...new TextEncoder().encode(alternateSource)],
      },
    };
    const bridge = createDirectRuntimeBridge();
    const checked = await bridge.check(alternateCheck);
    expect(checked.status).toBe('accepted');

    let calls = 0;
    const completed = await bridge.execute(
      executeRequest({ kind: 'source', source: alternateCheck }, event('open', 1_500_000n)),
      {
        handleAction: async (request) => {
          calls++;
          const input = decodeCanonical(ref(typeIds.taskInput), Uint8Array.from(request.input), {
            registry: registry.schemas,
          });
          expect(input).toEqual({
            ok: true,
            value: { relatedDealId: 'deal-1', title: 'Review Acme', workspaceId: 'workspace-1' },
          });
          return {
            requestId: request.requestId,
            result: {
              tag: 'completed',
              value: encoded(resultSchema(ref(typeIds.task), ref(typeIds.taskError)), {
                tag: 'ok',
                value: { id: 'task-1' },
              }),
            },
          };
        },
      },
    );
    expect(completed.status).toBe('completed');
    expect(calls).toBe(1);
    if (completed.status === 'completed') {
      expect(completed.facts.preparation.kind).toBe('source');
      if (completed.facts.preparation.kind === 'source') {
        expect(completed.facts.preparation.summary).toEqual({ operations: [operation] });
        expect(completed.facts.preparation.diagnostics).toEqual([]);
        expect(completed.facts.preparation.artifact).toBeUndefined();
      }
    }
  });

  it('carries UTF-8 source ranges from compilation into host action requests', async () => {
    const unicodeSource = `// 🛡️\n${source}`;
    const request = checkWithSource(unicodeSource);
    const callStart = unicodeSource.indexOf('ctx.tasks.create(');
    const callEnd = unicodeSource.indexOf('\n\n', callStart);
    const bytes = new TextEncoder();
    let action: ActionRequest | undefined;
    const completed = await createDirectRuntimeBridge().execute(executeRequest({ kind: 'source', source: request }), {
      handleAction: async (received) => {
        action = received;
        return {
          requestId: received.requestId,
          result: {
            tag: 'completed',
            value: encoded(resultSchema(ref(typeIds.task), ref(typeIds.taskError)), {
              tag: 'ok',
              value: { id: 'task-utf8' },
            }),
          },
        };
      },
    });

    expect(completed.status).toBe('completed');
    expect(action?.source).toEqual({
      module: moduleId,
      start: bytes.encode(unicodeSource.slice(0, callStart)).length,
      end: bytes.encode(unicodeSource.slice(0, callEnd)).length,
    });
  });

  it('resolves host actions from the registry instead of a tasks.create special case', async () => {
    const notificationOperationId = ids.operation('operation:notifications.send');
    const notificationOperation = {
      ...(registry.operations[0] as ContractRegistry['operations'][number]),
      id: notificationOperationId,
    };
    const notificationSlot = {
      ...(registry.slots[0] as ContractRegistry['slots'][number]),
      operations: [notificationOperationId],
    };
    const notificationRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(30),
      operations: [notificationOperation],
      slots: [notificationSlot],
      definitions: [
        ...definitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
        { id: notificationOperationId, fingerprint: notificationOperation.fingerprint },
        { id: slot, fingerprint: notificationSlot.fingerprint },
      ],
    };
    const notificationSource = source.replace('ctx.tasks.create', 'ctx.notifications.send');
    const checked = await createDirectRuntimeBridge().check({
      ...checkRequest,
      registry: notificationRegistry,
      source: {
        module: moduleId,
        source: [...new TextEncoder().encode(notificationSource)],
      },
    });
    expect(checked.status).toBe('accepted');
    if (checked.status === 'accepted') expect(checked.summary).toEqual({ operations: [notificationOperationId] });
  });

  it('checks, executes one typed action, and verifies artifact mode', async () => {
    const bridge = createDirectRuntimeBridge();
    const checked = await bridge.check({ ...checkRequest, includeArtifact: true });
    expect(checked.status).toBe('accepted');
    if (checked.status !== 'accepted') return;
    if (!checked.artifact) throw new Error('artifact serialization was not requested');
    expect(checked.diagnostics).toEqual([]);
    expect(checked.summary).toEqual({ operations: [operation] });
    let calls = 0;
    const completed = await bridge.execute(executeRequest({ kind: 'artifact', bytes: checked.artifact }), {
      handleAction: async (request) => {
        calls++;
        expect(request.operationId).toBe(operation);
        return {
          requestId: request.requestId,
          result: {
            tag: 'completed',
            value: encoded(resultSchema(ref(typeIds.task), ref(typeIds.taskError)), {
              tag: 'ok',
              value: { id: 'task-1' },
            }),
          },
        };
      },
    });
    expect(completed.status).toBe('completed');
    expect(calls).toBe(1);
    if (completed.status === 'completed')
      expect(completed.facts.actions.map((record) => record.phase)).toEqual(['requested', 'resolved']);
    if (completed.status === 'completed') {
      expect(completed.facts.preparation.kind).toBe('artifact');
      if (completed.facts.preparation.kind === 'artifact') {
        expect(completed.facts.preparation.irDigest).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('takes no-action paths and fails closed on a declared policy rejection', async () => {
    const bridge = createDirectRuntimeBridge();
    let calls = 0;
    const below = await bridge.execute(executeRequest({ kind: 'source', source: checkRequest }, event('open', 1n)), {
      handleAction: async () => {
        calls++;
        throw new Error('unreachable');
      },
    });
    const alreadyWon = await bridge.execute(executeRequest({ kind: 'source', source: checkRequest }, event('won')), {
      handleAction: async () => {
        calls++;
        throw new Error('unreachable');
      },
    });
    expect([below.status, alreadyWon.status, calls]).toEqual(['completed', 'completed', 0]);
    const rejected = await bridge.execute(
      executeRequest({ kind: 'source', source: { ...checkRequest, includeArtifact: true } }),
      {
        handleAction: async (request) =>
          ({
            requestId: request.requestId,
            result: { tag: 'rejected', value: { code: 'denied', detail: 'safe detail' } },
          }) as never,
      },
    );
    expect(rejected.status).toBe('failed');
    if (rejected.status === 'failed') {
      expect(rejected.error.code).toBe('action_outcome_invalid');
      expect(rejected.facts.preparation.kind).toBe('source');
      if (rejected.facts.preparation.kind === 'source')
        expect(rejected.facts.preparation.artifact?.length).toBeGreaterThan(0);
    }
  });

  it('fails closed before dispatch for source, artifact, and resource violations', async () => {
    const bridge = createDirectRuntimeBridge();
    const ambient = {
      ...checkRequest,
      source: {
        module: moduleId,
        source: [...new TextEncoder().encode('import fs from "node:fs"')],
      },
    };
    expect((await bridge.check(ambient)).status).toBe('rejected');
    const checked = await bridge.check({ ...checkRequest, includeArtifact: true });
    if (checked.status !== 'accepted') throw new Error('fixture rejected');
    if (!checked.artifact) throw new Error('artifact serialization was not requested');
    const corrupt = [...checked.artifact];
    corrupt[0] = 0;
    const corruptResult = await bridge.execute(executeRequest({ kind: 'artifact', bytes: corrupt }), {
      handleAction: async () => {
        throw new Error('unreachable');
      },
    });
    expect(corruptResult.status).toBe('not_started');
    if (corruptResult.status === 'not_started') expect(corruptResult.error?.code).toBe('artifact_verification_failed');
    let calls = 0;
    const exhausted = await bridge.execute(
      executeRequest({ kind: 'artifact', bytes: checked.artifact }, event(), {
        ...STANDARD_EXECUTION_LIMITS,
        fuel: 16,
      }),
      {
        handleAction: async () => {
          calls++;
          throw new Error('unreachable');
        },
      },
    );
    expect(exhausted.status).toBe('failed');
    expect(calls).toBe(0);
  });

  it('fails malformed action output and cancels a dispatched action without replay', async () => {
    const bridge = createDirectRuntimeBridge();
    let malformedCalls = 0;
    const malformed = await bridge.execute(executeRequest({ kind: 'source', source: checkRequest }), {
      handleAction: async (request) => {
        malformedCalls++;
        return {
          requestId: request.requestId,
          result: { tag: 'completed', value: [0] },
        };
      },
    });
    expect(malformed.status).toBe('failed');
    expect(malformedCalls).toBe(1);
    if (malformed.status === 'failed') {
      expect(malformed.facts.actions.map((record) => record.phase)).toEqual(['requested', 'resolved']);
      expect(malformed.facts.actions[1]).toMatchObject({
        phase: 'resolved',
        outcome: { result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'invalid_result' } } } },
      });
    }

    let release: (() => void) | undefined;
    let dispatched: ActionRequest | undefined;
    const invocationId = ids.invocation(`invocation:${crypto.randomUUID().replaceAll('-', '')}`);
    const pending = bridge.execute(
      { ...executeRequest({ kind: 'source', source: checkRequest }), invocationId },
      {
        handleAction: (request) =>
          new Promise<ActionOutcome>((resolve) => {
            dispatched = request;
            release = () =>
              resolve({
                requestId: request.requestId,
                result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'cancelled' } } },
              });
          }),
      },
    );
    while (!dispatched) await Promise.resolve();
    expect(await bridge.cancel({ invocationId })).toEqual({ status: 'accepted' });
    const cancelled = await pending;
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status === 'cancelled') {
      expect(cancelled.facts.actions.map((record) => record.phase)).toEqual(['requested', 'resolved']);
      release?.();
      await Promise.resolve();
      expect(cancelled.facts.actions.map((record) => record.phase)).toEqual(['requested', 'resolved']);
    }
  });
});

describe('compiler validation through the RuntimeBridge interface', () => {
  it('executes local reassignment and its updated value', async () => {
    const reassignmentSource = source
      .replace('export async function onDealUpdated(', 'export async function onDealUpdated(')
      .replace('  if (\n', '  let threshold = 1_000_000\n  threshold += 1_000_000\n\n  if (\n')
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < threshold');
    const language11Registry: ContractRegistry = {
      ...registry,
      digest: fingerprint(40),
      slots: registry.slots.map((candidate) => ({
        ...candidate,
      })),
    };
    const language11Request = {
      ...checkWithSource(reassignmentSource),
      registry: language11Registry,
    } as const;
    const bridge = createDirectRuntimeBridge();

    const checked = await bridge.check(language11Request);
    expect(checked.status).toBe('accepted');
    const inspected = await bridge.inspect({ ...language11Request, views: [semanticGraphView()] });
    expect(inspected.status).toBe('accepted');
    if (inspected.status === 'accepted') {
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(inspected))));
      expect(graph.nodes.some((node: { semanticKind: string }) => node.semanticKind === 'variable')).toBe(true);
      expect(graph.nodes.some((node: { semanticKind: string }) => node.semanticKind === 'host-action')).toBe(true);
      expect(graph.resources.actionNodes).toHaveLength(1);
      expect(graph.operations).toEqual([operation]);
    }
    let calls = 0;
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: language11Request }, event('open', 1_500_000n)),
        registry: language11Registry,
      },
      {
        handleAction: async () => {
          calls++;
          throw new Error('the reassigned threshold should suppress this action');
        },
      },
    );
    expect(completed.status).toBe('completed');
    expect(calls).toBe(0);
  });

  it('executes bounded for-of loops through named pure helper calls', async () => {
    const helperSource = source
      .replace(
        'export async function onDealUpdated(',
        `function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    total += value
  }
  return total
}

export async function onDealUpdated(`,
      )
      .replace('  if (\n', '  const threshold = sum([500_000, 1_500_000])\n\n  if (\n')
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < threshold');
    const language11Registry: ContractRegistry = {
      ...registry,
      digest: fingerprint(41),
      slots: registry.slots.map((candidate) => ({
        ...candidate,
      })),
    };
    const language11Request = {
      ...checkWithSource(helperSource),
      registry: language11Registry,
    } as const;
    const bridge = createDirectRuntimeBridge();

    const checked = await bridge.check(language11Request);
    expect(checked.status).toBe('accepted');
    let calls = 0;
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: language11Request }, event('open', 1_999_999n)),
        registry: language11Registry,
      },
      {
        handleAction: async () => {
          calls++;
          throw new Error('the helper-derived threshold should suppress this action');
        },
      },
    );
    expect(completed.status).toBe('completed');
    expect(calls).toBe(0);
  });

  it('executes every loop form with charged break and continue control flow', async () => {
    const loopSource = source
      .replace(
        'export async function onDealUpdated(',
        `function threshold(): number {
  let total = 0
  for (let index = 0; index < 2; index++) {
    total += 250_000
  }
  let step = 0
  while (step < 2) {
    step++
    if (step === 1) continue
    total += 500_000
  }
  do {
    total += 500_000
    break
  } while (true)
  const fields = { first: 500_000, second: 0 }
  for (const key in fields) {
    total += fields[key]
  }
  return total
}

export async function onDealUpdated(`,
      )
      .replace('  if (\n', '  const required = threshold()\n\n  if (\n')
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const language11Registry: ContractRegistry = {
      ...registry,
      digest: fingerprint(42),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(loopSource),
      registry: language11Registry,
    } as const;
    const bridge = createDirectRuntimeBridge();

    expect((await bridge.check(request)).status).toBe('accepted');
    let calls = 0;
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: language11Registry,
      },
      {
        handleAction: async () => {
          calls++;
          throw new Error('the loop-derived threshold should suppress this action');
        },
      },
    );
    expect(completed.status).toBe('completed');
    expect(calls).toBe(0);
  });

  it('executes recursive higher-order functions and captured arrow callbacks', async () => {
    const functionSource = source
      .replace(
        'export async function onDealUpdated(',
        `function recursive(value: number): number {
  if (value === 0) return 0
  return 250_000 + recursive(value - 1)
}

function addOffset(offset: number): (value: number) => number {
  return (value) => value + offset
}

export async function onDealUpdated(`,
      )
      .replace(
        '  if (\n',
        `  const adjusted = [250_000, 500_000]
    .map(addOffset(250_000))
    .filter((value) => value >= 500_000)
    .reduce((total, value) => total + value, 0)
  const required = adjusted + recursive(3)

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const language11Registry: ContractRegistry = {
      ...registry,
      digest: fingerprint(43),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(functionSource),
      registry: language11Registry,
    } as const;
    const bridge = createDirectRuntimeBridge();

    expect((await bridge.check(request)).status).toBe('accepted');
    let calls = 0;
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: language11Registry,
      },
      {
        handleAction: async () => {
          calls++;
          throw new Error('the higher-order threshold should suppress this action');
        },
      },
    );
    expect(completed.status).toBe('completed');
    expect(calls).toBe(0);
  });

  it.each([
    ['unsafe typing', 'function unsafe(value: any): any { return value }'],
    ['value mutation', 'function mutate(value: { x: number }): number { value.x = 1; return value.x }'],
    ['exceptions', 'function fail(): number { try { throw 1 } catch { return 1 } }'],
    ['generated code', 'function generated(): number { return eval("1") }'],
    ['regular expressions', 'function regex(): boolean { return /x/.test("x") }'],
    ['floating actions', 'function floating(ctx: Context): void { ctx.tasks.create({}) }'],
    ['action racing', 'function racing(value: Promise<void>): Promise<void> { return Promise.race([value]) }'],
  ])('rejects %s before IR', async (_name, unsafeHelper) => {
    const unsafeSource = source.replace(
      'export async function onDealUpdated(',
      `${unsafeHelper}\n\nexport async function onDealUpdated(`,
    );
    const unsafeRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(44),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const result = await createDirectRuntimeBridge().check({
      ...checkWithSource(unsafeSource),
      registry: unsafeRegistry,
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.diagnostics[0]?.code).toStartWith('SS_');
  });

  it('erases finite aliases, interfaces, recursive types, tuples, and monomorphic generics', async () => {
    const typedSource = source
      .replace(
        'export async function onDealUpdated(',
        `interface Linked<T> { readonly value: T; readonly next?: Linked<T> }
type Pair<T> = readonly [T, T]
type Tagged = ({ readonly tag: "amount" } & { readonly value: number }) | { readonly tag: "none" }

function sum<const T extends number>(values: Pair<T>): number {
  return values[0] + values[1]
}

export async function onDealUpdated(`,
      )
      .replace('  if (\n', '  const required = sum([1_000_000, 1_000_000] as const)\n\n  if (\n')
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const typedRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(45),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(typedSource),
      registry: typedRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      { ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)), registry: typedRegistry },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');
  });

  it('executes deterministic Object, Unicode string, and Math intrinsics', async () => {
    const intrinsicSource = source
      .replace(
        '  if (\n',
        `  const amounts = Object.values({ first: 500_000, second: 500_000 })
  const subtotal = amounts.reduce((total, value) => total + value, 0)
  const label = "  safe  ".trim().toUpperCase()
  const required = label === "SAFE" ? subtotal + Math.abs(-1_000_000) : 0

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const intrinsicRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(46),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(intrinsicSource),
      registry: intrinsicRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: intrinsicRegistry,
      },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');
  });

  it('executes checked JSON, numeric parsing, Bytes, Temporal, and console intrinsics', async () => {
    const dataSource = source
      .replace(
        'export async function onDealUpdated(',
        `function decodedAmount(): number {
  const parsed = JSON.parse<{ readonly value: number }>("{\\"value\\":1000000}")
  switch (parsed.tag) {
    case "ok": return parsed.value.value
    case "error": return 0
  }
}

function numericAmount(): number {
  const parsed = parseInt64("1000000")
  switch (parsed.tag) {
    case "ok": return parsed.value
    case "error": return 0
  }
}

export async function onDealUpdated(`,
      )
      .replace(
        '  if (\n',
        `  const bytes = Bytes.fromUtf8("safe")
  const instant = Temporal.Instant.from("2026-08-07T00:00:00Z")
  const current = Temporal.Now.instant()
  const random = Math.random()
  console.info("checked", bytes.length, instant)
  const required = current === instant && random === random ? decodedAmount() + numericAmount() : 0

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const dataRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(47),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(dataSource),
      registry: dataRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: dataRegistry,
        trace: true,
        fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
        randomSeed: [1, 2, 3, 4],
      },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');
    if (completed.status === 'completed') expect(completed.facts.trace.records.length).toBeGreaterThan(0);
  });

  it('lowers optional syntax and undefined checks to canonical Option absence', async () => {
    const optionSource = source
      .replace(
        '  if (\n',
        `  const settings: { readonly threshold?: number } = {}
  const absent = settings.threshold === undefined
  const required = absent ? (settings.threshold ?? 2_000_000) : 0

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const optionRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(48),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(optionSource),
      registry: optionRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      { ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)), registry: optionRegistry },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');

    const nullResult = await bridge.check({
      ...request,
      source: {
        module: moduleId,
        source: [...new TextEncoder().encode(optionSource.replace('{}', '{ threshold: null }'))],
      },
    });
    expect(nullResult.status).toBe('rejected');
  });

  it('rejects Promise.all action groups before IR', async () => {
    const actionInput = `{
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`Onboard \${event.after.name}\`,
  }`;
    const actionsSource = source.replace(
      `const result = await ctx.tasks.create(${actionInput})`,
      `const results = await Promise.all([
    ctx.tasks.create(${actionInput}),
    ctx.tasks.create(${actionInput}),
  ])
  const result = results[1]`,
    );
    const checked = await createDirectRuntimeBridge().check(checkWithSource(actionsSource));
    expect(checked.status).toBe('rejected');
    if (checked.status === 'rejected') expect(checked.diagnostics[0]?.code).toBe('SS_PROMISE_CONCURRENCY');
  });

  it('executes immutable spread and object and tuple destructuring', async () => {
    const destructuringSource = source
      .replace(
        '  if (\n',
        `  const base = { first: 500_000, second: 500_000 }
  const combined = { ...base, third: 500_000 }
  const values = [...Object.values(combined), 500_000]
  const [first, second, third, fourth] = values
  const { first: named } = combined
  const required = first + second + third + fourth + named - 500_000

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const destructuringRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(51),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(destructuringSource),
      registry: destructuringRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: destructuringRegistry,
      },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');
  });

  it('executes immutable replacement, reversal, splicing, and stable sorting', async () => {
    const collectionSource = source
      .replace(
        '  if (\n',
        `  const values = [250_000, 500_000, 750_000]
    .with(0, 500_000)
    .toReversed()
    .toSpliced(1, 1, 250_000)
    .toSorted((left, right) => left - right)
  const required = values.reduce((total, value) => total + value, 0) + 500_000

  if (
`,
      )
      .replace('event.after.amount.minorUnits < 2_000_000', 'event.after.amount.minorUnits < required');
    const collectionRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(52),
      slots: registry.slots.map((candidate) => ({ ...candidate })),
    };
    const request = {
      ...checkWithSource(collectionSource),
      registry: collectionRegistry,
    } as const;
    const bridge = createDirectRuntimeBridge();
    expect((await bridge.check(request)).status).toBe('accepted');
    const completed = await bridge.execute(
      {
        ...executeRequest({ kind: 'source', source: request }, event('open', 1_999_999n)),
        registry: collectionRegistry,
      },
      unreachableHost,
    );
    expect(completed.status).toBe('completed');
    const mutating = await bridge.check({
      ...request,
      source: {
        module: moduleId,
        source: [...new TextEncoder().encode(collectionSource.replace('.toReversed()', '.reverse()'))],
      },
    });
    expect(mutating.status).toBe('rejected');
  });

  it.each([
    ['SS_SYNTAX', source.replace('export async function', 'export async function )')],
    ['SS_AMBIENT_AUTHORITY', 'import { Ok } from "node:fs"\n' + source],
    ['SS_IMPORT_NAME', 'import { Nope } from "safescript:prelude"\n' + source],
    ['SS_MODULE_SHAPE', source + '\nconst extra = 1'],
    ['SS_HANDLER_SHAPE', source.replace('export async function', 'function')],
    ['SS_INVALID_ACTION', source.replace('ctx.tasks.create({', 'ctx.tasks.missing({')],
  ] as const)('rejects %s deterministically', async (code, invalidSource) => {
    const bridge = createDirectRuntimeBridge();
    const result = await bridge.check(checkWithSource(invalidSource));
    const repeated = await bridge.check(checkWithSource(invalidSource));
    expect(result.status).toBe('rejected');
    expect(repeated).toEqual(result);
    if (result.status === 'rejected') {
      expect(result.diagnostics[0]?.code).toBe(code);
      expect(result.diagnostics[0]?.message.length ?? 0).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    }
  });

  it('reports rejected source locations as UTF-8 byte ranges', async () => {
    const invalidSource = `// 🧪\n${source.replace('ctx.tasks.create(', 'ctx.tasks.missing(')}`;
    const callStart = invalidSource.indexOf('ctx.tasks.missing(');
    const callEnd = invalidSource.indexOf('\n\n', callStart);
    const bytes = new TextEncoder();
    const result = await createDirectRuntimeBridge().check(checkWithSource(invalidSource));

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.diagnostics[0]?.location).toEqual({
        module: moduleId,
        start: bytes.encode(invalidSource.slice(0, callStart)).length,
        end: bytes.encode(invalidSource.slice(0, callEnd)).length,
      });
    }
  });

  it('bounds non-normative diagnostic text independently of stable code and provenance', async () => {
    const importedName = `Missing${'X'.repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH * 2)}`;
    const result = await createDirectRuntimeBridge().check(
      checkWithSource(`import { ${importedName} } from "safescript:prelude"\n${source}`),
    );
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.diagnostics[0]?.code).toBe('SS_IMPORT_NAME');
      expect(result.diagnostics[0]?.message.length ?? 0).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
      expect(result.diagnostics[0]?.message).not.toContain(importedName);
      expect(result.diagnostics[0]?.location?.module).toBe(moduleId);
    }
  });

  it('rejects invalid compile ceilings before parsing', async () => {
    const bridge = createDirectRuntimeBridge();
    expect(
      (
        await bridge.check({
          ...checkRequest,
          limits: { ...STANDARD_COMPILE_LIMITS, sourceBytes: STANDARD_COMPILE_LIMITS.sourceBytes + 1 },
        })
      ).status,
    ).toBe('rejected');
    const withoutDiagnostics = await bridge.check({
      ...checkRequest,
      limits: {
        ...STANDARD_COMPILE_LIMITS,
        includeDiagnostics: false,
        sourceBytes: STANDARD_COMPILE_LIMITS.sourceBytes + 1,
      },
    });
    expect(withoutDiagnostics.status).toBe('rejected');
    if (withoutDiagnostics.status === 'rejected') expect(withoutDiagnostics.diagnostics).toEqual([]);
    expect(
      (
        await bridge.check({
          ...checkRequest,
          limits: { ...STANDARD_COMPILE_LIMITS, typeInstantiationWork: 1 } as never,
        })
      ).status,
    ).toBe('rejected');
    expect(
      (
        await bridge.check({
          ...checkRequest,
          limits: { ...STANDARD_COMPILE_LIMITS, diagnostics: 0 } as never,
        })
      ).status,
    ).toBe('rejected');
    expect(
      (
        await bridge.check({
          ...checkRequest,
          limits: { ...STANDARD_COMPILE_LIMITS, typeDepth: 0 },
        })
      ).status,
    ).toBe('rejected');
    expect(
      (
        await bridge.check({
          ...checkRequest,
          limits: { ...STANDARD_COMPILE_LIMITS, derivedTemplateBytes: 1 },
        })
      ).status,
    ).toBe('rejected');
    expect(
      (
        await bridge.check({
          ...checkRequest,
          source: { ...checkRequest.source, module: 'module invalid' as never },
        })
      ).status,
    ).toBe('rejected');
    expect(
      (
        await bridge.check({
          ...checkRequest,
          source: { module: moduleId, source: [0xff] },
        })
      ).status,
    ).toBe('rejected');
  });
});

describe('inspection and bridge lifecycle', () => {
  it('inspects semantic graph schema 1.0 through correlated tagged view records', async () => {
    const result = await createDirectRuntimeBridge().inspect({
      ...checkRequest,
      views: [semanticGraphView()],
    });

    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.views).toHaveLength(1);
      expect(result.views[0]?.kind).toBe('semantic_graph');
      expect(result.views[0]?.status).toBe('accepted');
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(result))));
      expect(graph.schema).toEqual(SEMANTIC_GRAPH_SCHEMA);
    }
  });

  it('covers source-only declarations and structural insertion sites in one semantic revision', async () => {
    const modelSource = source.replace(
      'export async function onDealUpdated(',
      `interface Box<T> { readonly value: T }
type Pair<T> = readonly [T, T]

function first<const T>(values: Pair<T>): T {
  return values[0]
}

function count(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    total++
  }
  return total
}

export async function onDealUpdated(`,
    );
    const completeModelSource = modelSource.replace(
      '  const result = await ctx.tasks.create({',
      `  const copied = [...[1, 2]]
  const label = \`safe\`
  count(copied)
  label

  const result = await ctx.tasks.create({`,
    );
    const request = checkWithSource(completeModelSource);
    const first = await createDirectRuntimeBridge().inspect({ ...request, views: [semanticGraphView()] });
    const second = await createDirectRuntimeBridge().inspect({ ...request, views: [semanticGraphView()] });

    expect(first.status).toBe('accepted');
    expect(second).toEqual(first);
    if (first.status === 'accepted') {
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(first)))) as SemanticGraph;
      expect(graph.semanticRevision).toMatch(/^semantic-revision:[0-9a-f]{64}$/);
      const kinds = new Set(graph.nodes.map((node) => node.semanticKind));
      for (const expected of [
        'module',
        'import-declaration',
        'import-specifier',
        'interface',
        'type-alias',
        'type-parameter',
        'parameter',
        'return-type',
        'statement-container',
        'parameter-container',
        'argument-container',
        'array-element',
        'template-container',
        'assign',
      ] as const)
        expect(kinds.has(expected), expected).toBe(true);
      expect(
        graph.nodes.some(
          (node) => node.semanticKind === 'unary' && (node as { readonly operator?: string }).operator === '++',
        ),
      ).toBe(true);
      expect(primitiveEditCoverage(graph)).toMatchObject({ uncoveredNodes: [], uncoveredAnchors: [] });
      expect(
        graph.nodes.some(
          (node) => node.semanticKind === 'array-element' && (node as { readonly label?: string }).label === 'spread',
        ),
      ).toBe(true);
    }
  });

  it('publishes complete ordered anchors and explicit binding relationships', async () => {
    const result = await createDirectRuntimeBridge().inspect({ ...checkRequest, views: [semanticGraphView()] });
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(result)))) as {
        readonly nodes: readonly {
          readonly id: string;
          readonly kind: string;
          readonly source?: unknown;
          readonly editable?: unknown;
        }[];
        readonly edges: readonly {
          readonly kind: string;
          readonly from: string;
          readonly to: string;
          readonly index?: number;
        }[];
        readonly anchors: readonly {
          readonly container: string;
          readonly index: number;
          readonly before?: string;
          readonly after?: string;
        }[];
      };
      expect(graph.nodes.every((node) => node.source === undefined || node.editable !== undefined)).toBe(true);
      expect(graph.edges.some((edge) => edge.kind === 'binds')).toBe(true);
      expect(graph.edges.some((edge) => edge.kind === 'references')).toBe(true);
      expect(graph.edges.some((edge) => edge.kind === 'type')).toBe(true);
      for (const container of graph.nodes.filter((node) => node.kind === 'container')) {
        const children = graph.edges.filter((edge) => edge.kind === 'contains' && edge.from === container.id);
        const anchors = graph.anchors.filter((anchor) => anchor.container === container.id);
        expect(children.map((edge) => edge.index)).toEqual(children.map((_edge, index) => index));
        expect(anchors.map((anchor) => anchor.index)).toEqual(
          Array.from({ length: children.length + 1 }, (_value, index) => index),
        );
      }
    }
  });

  it('applies a primitive edit against compiler-produced identities and rechecks the complete candidate', async () => {
    const inspected = await createDirectRuntimeBridge().inspect({ ...checkRequest, views: [semanticGraphView()] });
    expect(inspected.status).toBe('accepted');
    if (inspected.status !== 'accepted') return;
    const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(inspected)))) as SemanticGraph;
    const binding = graph.nodes.find(
      (node) => node.kind === 'binding' && node.semanticKind === 'symbol' && node.label === 'event',
    );
    if (!binding) throw new Error('expected compiler-produced event binding');
    const selectedSlot = registry.slots[0];
    if (!selectedSlot) throw new Error('test registry requires a slot');
    const result = applyPrimitiveSemanticEdits(
      checkRequest.source,
      graph,
      graph.semanticRevision,
      [
        {
          kind: 'rename_symbol',
          editId: 'edit:compiler-rename' as SemanticEditId,
          target: binding.id,
          newName: 'updatedEvent',
          preconditions: [{ kind: 'old_name', value: 'event' }],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
      (candidate) => {
        const checked = compileProgram(
          new TextDecoder().decode(Uint8Array.from(candidate.source)),
          moduleId,
          registry,
          selectedSlot,
        );
        return checked.ok
          ? { ok: true }
          : {
              ok: false,
              diagnostics: [
                { message: checked.failure.message, start: checked.failure.start, end: checked.failure.end },
              ],
            };
      },
    );
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      const updated = new TextDecoder().decode(Uint8Array.from(result.source.source));
      expect(updated).toContain('updatedEvent: DealUpdated');
      expect(updated).not.toContain('event.before');
      expect(updated).toContain('updatedEvent.before');
    }
  });

  it('applies semantic edits through the direct bridge and rebuilds hashes, diff, and requested views', async () => {
    const bridge = createDirectRuntimeBridge();
    const inspected = await bridge.inspect({
      ...checkRequest,
      views: [semanticGraphView(), semanticCapabilitiesView()],
    });
    expect(inspected.status).toBe('accepted');
    if (inspected.status !== 'accepted') return;
    const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(inspected)))) as SemanticGraph;
    const capabilityView = inspected.views.find((view) => view.kind === 'semantic_edit_capabilities');
    expect(capabilityView?.status).toBe('accepted');
    if (!capabilityView || capabilityView.status !== 'accepted') return;
    const manifest = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(capabilityView.bytes)),
    ) as SemanticEditCapabilityManifest;
    const binding = graph.nodes.find(
      (node) => node.kind === 'binding' && node.semanticKind === 'symbol' && node.label === 'event',
    );
    if (!binding) throw new Error('expected compiler-produced event binding');
    const rename = manifest.targets
      .find((target) => target.target === binding.id)
      ?.capabilities.find((capability) => capability.kind === 'rename_symbol');
    if (!rename) throw new Error('expected compiler-produced rename capability');
    const invalidTarget = graph.nodes.find((node) => node.semanticKind === 'literal' && node.constant === 'won');
    if (!invalidTarget) throw new Error('expected compiler-produced string literal');
    const request = {
      ...checkRequest,
      editSchema: SEMANTIC_EDIT_SCHEMA,
      graphSchema: SEMANTIC_GRAPH_SCHEMA,
      baseRevision: graph.semanticRevision,
      edits: [
        {
          kind: 'rename_symbol' as const,
          editId: 'edit:bridge-rename' as SemanticEditId,
          target: binding.id,
          newName: 'updatedEvent',
          preconditions: rename.preconditions,
        },
      ],
      editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
      views: [semanticGraphView()],
    };
    const first = await bridge.applySemanticEdits(request);
    const second = await bridge.applySemanticEdits(request);
    expect(second).toEqual(first);
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;
    const updated = new TextDecoder().decode(Uint8Array.from(first.source.source));
    expect(updated).toContain('updatedEvent: DealUpdated');
    expect(first.sourceHash).not.toBe(graph.sourceHash);
    expect(first.programHash).not.toBe(graph.programHash);
    expect(first.semanticRevision).not.toBe(graph.semanticRevision);
    expect(first.outcomes).toEqual([
      expect.objectContaining({ editId: 'edit:bridge-rename', targets: expect.arrayContaining([binding.id]) }),
    ]);
    expect(first.diff.entries.some((entry) => entry.kind === 'renamed' && entry.before.includes(binding.id))).toBe(
      true,
    );
    expect(first.views.map((view) => view.kind)).toEqual(['semantic_graph']);
    expect(
      await bridge.applySemanticEdits({
        ...request,
        baseRevision: `semantic-revision:${'0'.repeat(64)}` as typeof graph.semanticRevision,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'stale_revision' });
    expect(
      await bridge.applySemanticEdits({
        ...request,
        editLimits: { ...STANDARD_SEMANTIC_EDIT_LIMITS, diffBytes: 1 },
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: 'edit_limit_exceeded',
      limit: { limit: 'diff_bytes', maximum: 1 },
    });
    expect(
      await bridge.applySemanticEdits({
        ...request,
        edits: [...request.edits, request.edits[0] as (typeof request.edits)[number]],
      }),
    ).toMatchObject({ status: 'bridge_error', error: { phase: 'apply_semantic_edits', code: 'invalid_request' } });
    expect(
      await bridge.applySemanticEdits({
        ...request,
        edits: [
          {
            kind: 'replace_target',
            editId: 'edit:invalid-candidate' as SemanticEditId,
            target: invalidTarget.id,
            replacement: {
              category: 'expression',
              source: [...new TextEncoder().encode('/x/')],
            },
            preconditions: [],
          },
        ],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'transformed_source_rejected' });
  });

  it('closes semantic edit lifecycle failures and capability limits without partial bytes', async () => {
    const bridge = createDirectRuntimeBridge();
    const bounded = await bridge.inspect({
      ...checkRequest,
      views: [
        {
          ...semanticCapabilitiesView(),
          limits: { ...STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS, targets: 0 },
        },
      ],
    });
    expect(bounded.status).toBe('accepted');
    if (bounded.status === 'accepted')
      expect(bounded.views).toEqual([
        {
          kind: 'semantic_edit_capabilities',
          status: 'rejected',
          error: expect.objectContaining({ code: 'capability_limit_exceeded', limit: 'targets', maximum: 0 }),
        },
      ]);
    expect(
      await bridge.applySemanticEdits({
        ...checkRequest,
        source: { ...checkRequest.source, source: [0xff] },
        editSchema: SEMANTIC_EDIT_SCHEMA,
        graphSchema: SEMANTIC_GRAPH_SCHEMA,
        baseRevision: `semantic-revision:${'1'.repeat(64)}` as never,
        edits: [
          {
            kind: 'delete_target',
            editId: 'edit:invalid-source' as SemanticEditId,
            target: `semantic-node:${'2'.repeat(64)}` as SemanticNodeId,
            commentPolicy: 'preserve_owned_comments',
            preconditions: [],
          },
        ],
        editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'source_rejected' });
    await bridge.close();
    expect(
      await bridge.applySemanticEdits({
        ...checkRequest,
        editSchema: SEMANTIC_EDIT_SCHEMA,
        graphSchema: SEMANTIC_GRAPH_SCHEMA,
        baseRevision: `semantic-revision:${'1'.repeat(64)}` as never,
        edits: [
          {
            kind: 'delete_target',
            editId: 'edit:closed' as SemanticEditId,
            target: `semantic-node:${'2'.repeat(64)}` as SemanticNodeId,
            commentPolicy: 'preserve_owned_comments',
            preconditions: [],
          },
        ],
        editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
      }),
    ).toMatchObject({ status: 'bridge_error', error: { phase: 'apply_semantic_edits', code: 'bridge_closed' } });
  });

  it('returns a semantic graph only when requested', async () => {
    const bridge = createDirectRuntimeBridge();
    const inspected = await bridge.inspect({ ...checkRequest, views: [semanticGraphView()] });
    expect(inspected.status).toBe('accepted');
    if (inspected.status === 'accepted') {
      expect(inspected.check.status).toBe('accepted');
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(inspected))));
      expect(graph.nodes.filter((node: { kind: string }) => node.kind === 'action')).toHaveLength(1);
      expect(graph.nodes.some((node: { kind: string }) => node.kind === 'constant')).toBe(true);
      expect(graph.edges.some((edge: { kind: string }) => edge.kind === 'data')).toBe(true);
      expect(graph.contract.id).toBe(registry.id);
    }
    const omitted = await bridge.inspect({ ...checkRequest, views: [] });
    if (omitted.status === 'accepted') {
      expect(omitted.views).toEqual([]);
    }
  });

  it('reports semantic graph locations as UTF-8 byte ranges', async () => {
    const unicodeSource = `// 🧭\n${source}`;
    const callStart = unicodeSource.indexOf('ctx.tasks.create(');
    const callEnd = unicodeSource.indexOf('\n\n', callStart);
    const inspected = await createDirectRuntimeBridge().inspect({
      ...checkWithSource(unicodeSource),
      views: [semanticGraphView()],
    });

    expect(inspected.status).toBe('accepted');
    if (inspected.status === 'accepted') {
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(semanticGraphBytes(inspected)))) as {
        readonly nodes: readonly { readonly kind: string; readonly source?: unknown }[];
      };
      const bytes = new TextEncoder();
      expect(graph.nodes.find((node) => node.kind === 'action')?.source).toEqual({
        module: moduleId,
        start: bytes.encode(unicodeSource.slice(0, callStart)).length,
        end: bytes.encode(unicodeSource.slice(0, callEnd)).length,
      });
    }
  });

  it('keeps formatting-insensitive graph IDs and fails graph export atomically at independent limits', async () => {
    const bridge = createDirectRuntimeBridge();
    const first = await bridge.inspect({ ...checkRequest, views: [semanticGraphView()] });
    const formatted = await bridge.inspect({
      ...checkWithSource(`\n\n${source.replaceAll('  ', '    ')}\n// formatting-only comment\n`),
      views: [semanticGraphView()],
    });
    expect(first.status).toBe('accepted');
    expect(formatted.status).toBe('accepted');
    if (first.status === 'accepted' && formatted.status === 'accepted') {
      const decode = (bytes: readonly number[]) => JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
      const firstGraph = decode(semanticGraphBytes(first));
      const formattedGraph = decode(semanticGraphBytes(formatted));
      expect(firstGraph.nodes.map((node: { id: string }) => node.id)).toEqual(
        formattedGraph.nodes.map((node: { id: string }) => node.id),
      );
    }
    const bounded = await bridge.inspect({
      ...checkRequest,
      views: [semanticGraphView({ nodes: 1, edges: 250_000, bytes: 4 * 1024 * 1024 })],
    });
    expect(bounded.status).toBe('accepted');
    if (bounded.status === 'accepted') {
      expect(bounded.check.status).toBe('accepted');
      expect(bounded.views).toEqual([
        {
          kind: 'semantic_graph',
          status: 'rejected',
          error: {
            code: 'graph_limit_exceeded',
            limit: 'nodes',
            maximum: 1,
            actual: 2,
          },
        },
      ]);
    }
    const byteBounded = await bridge.inspect({
      ...checkRequest,
      views: [semanticGraphView({ nodes: 100_000, edges: 250_000, bytes: 1 })],
    });
    expect(byteBounded.status).toBe('accepted');
    if (byteBounded.status === 'accepted') {
      expect(byteBounded.views).toEqual([
        {
          kind: 'semantic_graph',
          status: 'rejected',
          error: {
            code: 'graph_limit_exceeded',
            limit: 'bytes',
            maximum: 1,
            actual: 2,
          },
        },
      ]);
    }
  });

  it('rejects malformed, duplicate, unsupported, and excessive tagged view requests without throwing', async () => {
    const bridge = createDirectRuntimeBridge();
    const malformed = [
      [{ ...semanticGraphView(), schema: { major: 2, minor: 0 } }],
      [semanticGraphView(), semanticGraphView()],
      [{ kind: 'semantic_graph', schema: SEMANTIC_GRAPH_SCHEMA }],
      [semanticGraphView({ ...STANDARD_SEMANTIC_GRAPH_LIMITS, nodes: STANDARD_SEMANTIC_GRAPH_LIMITS.nodes + 1 })],
    ];
    for (const views of malformed) {
      const result = await bridge.inspect({ ...checkRequest, views } as never);
      expect(result).toMatchObject({ status: 'bridge_error', error: { code: 'invalid_request', phase: 'inspect' } });
    }
  });

  it('closes idempotently and rejects later operations', async () => {
    const bridge = createDirectRuntimeBridge();
    expect(await bridge.close()).toEqual({ status: 'closed' });
    expect(await bridge.close()).toEqual({ status: 'closed' });
    expect((await bridge.check(checkRequest)).status).toBe('bridge_error');
    expect((await bridge.inspect({ ...checkRequest, views: [] })).status).toBe('bridge_error');
    expect(
      (await bridge.execute(executeRequest({ kind: 'source', source: checkRequest }), unreachableHost)).status,
    ).toBe('bridge_error');
    expect(
      (
        await bridge.cancel({
          invocationId: ids.invocation(`invocation:${'c'.repeat(32)}`),
        })
      ).status,
    ).toBe('bridge_error');
  });

  it('reports inactive cancellation requests', async () => {
    const bridge = createDirectRuntimeBridge();
    const invocationId = ids.invocation(`invocation:${'a'.repeat(32)}`);
    expect(await bridge.cancel({ invocationId })).toEqual({ status: 'not_active' });
  });
});

describe('execution validation, limits, and host outcomes', () => {
  it('rejects invalid execution envelopes without dispatch', async () => {
    const bridge = createDirectRuntimeBridge();
    expect(
      (
        await bridge.execute(
          executeRequest({ kind: 'source', source: checkRequest }, event(), {
            ...STANDARD_EXECUTION_LIMITS,
            fuel: STANDARD_EXECUTION_LIMITS.fuel + 1,
          }),
          unreachableHost,
        )
      ).status,
    ).toBe('not_started');
    expect(
      (
        await bridge.execute(
          {
            ...executeRequest({ kind: 'source', source: checkRequest }),
            limits: { ...STANDARD_EXECUTION_LIMITS, retainedBytes: 1 } as never,
          },
          unreachableHost,
        )
      ).status,
    ).toBe('not_started');
    expect(
      (
        await bridge.execute(
          { ...executeRequest({ kind: 'source', source: checkRequest }), input: [0] },
          unreachableHost,
        )
      ).status,
    ).toBe('not_started');
  });

  it('prevents duplicate active invocation IDs', async () => {
    const bridge = createDirectRuntimeBridge();
    const invocationId = ids.invocation(`invocation:${'d'.repeat(32)}`);
    let release: (() => void) | undefined;
    const pending = bridge.execute(
      { ...executeRequest({ kind: 'source', source: checkRequest }), invocationId },
      {
        handleAction: () =>
          new Promise<ActionOutcome>((resolve) => {
            release = () =>
              resolve({
                requestId: ids.request(invocationId, 0),
                result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'cancelled' } } },
              });
          }),
      },
    );
    while (!release) await Promise.resolve();
    const duplicate = await bridge.execute(
      { ...executeRequest({ kind: 'source', source: checkRequest }), invocationId },
      unreachableHost,
    );
    expect(duplicate.status).toBe('not_started');
    await bridge.cancel({ invocationId });
    release?.();
    await pending;
  });

  it.each([
    ['handler fault', async () => Promise.reject(new Error('host failed')), 'handler_fault'],
    [
      'mismatched request',
      async () => ({
        requestId: ids.request(ids.invocation(`invocation:${'f'.repeat(32)}`), 0),
        result: {
          tag: 'failed' as const,
          value: { effectState: 'unknown' as const, failure: { code: 'gateway_fault' as const } },
        },
      }),
      'action_outcome_invalid',
    ],
    [
      'explicit failure',
      async (request: ActionRequest) => ({
        requestId: request.requestId,
        result: {
          tag: 'failed' as const,
          value: { effectState: 'unknown' as const, failure: { code: 'unavailable' as const } },
        },
      }),
      'unavailable',
    ],
  ] as const)('maps %s to a stable execution fault', async (_name, handleAction, code) => {
    const result = await createDirectRuntimeBridge().execute(executeRequest({ kind: 'source', source: checkRequest }), {
      handleAction,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).toBe(code);
  });

  it.each([
    ['hostCalls', { hostCalls: 0 }],
    ['allocations', { allocations: 0 }],
    ['traceBytes', { traceBytes: 1 }],
  ])('enforces or records the %s ceiling', async (limit, override) => {
    const request = {
      ...executeRequest({ kind: 'source' as const, source: checkRequest }, event(), {
        ...STANDARD_EXECUTION_LIMITS,
        ...override,
      }),
      trace: true,
    };
    const result = await createDirectRuntimeBridge().execute(request, unreachableHost);
    if (limit === 'traceBytes') {
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.facts.trace.truncated).toBe(true);
    } else {
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error.code).toBe('resource_exhausted');
    }
  });
});
