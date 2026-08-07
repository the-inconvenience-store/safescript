import { describe, expect, it } from 'bun:test';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
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
  type Schema,
  type StringSchema,
  type TypeDefinition,
} from '@safescript/contracts';

import { createDirectRuntimeBridge } from './index.js';

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
const effect = ids.effect('effect:tasks.create');
const capability = ids.capability('capability:tasks.write');
const operation = ids.operation('operation:tasks.create');
const slot = ids.slot('slot:deal.updated');
const fingerprint = (value: number) => hash('contract', Uint8Array.of(value));
const registry: ContractRegistry = {
  id: ids.contract('contract:crm'),
  version: { major: 1, minor: 0, patch: 0 },
  digest: fingerprint(20),
  schemas: defineSchemaRegistry(definitions),
  effects: [{ id: effect, fingerprint: fingerprint(21) }],
  capabilities: [{ id: capability, fingerprint: fingerprint(22) }],
  operations: [
    {
      id: operation,
      input: typeIds.taskInput,
      output: typeIds.task,
      error: typeIds.taskError,
      effect,
      capability,
      effectCost: 10,
      idempotency: 'required',
      fingerprint: fingerprint(23),
    },
  ],
  slots: [
    {
      id: slot,
      input: typeIds.event,
      output: typeIds.result,
      languageVersion: { major: 1, minor: 0 },
      effects: [effect],
      capabilities: [capability],
      compileLimits: STANDARD_COMPILE_LIMITS,
      executionLimits: STANDARD_EXECUTION_LIMITS,
      fingerprint: fingerprint(24),
    },
  ],
  definitions: [
    ...definitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
    { id: effect, fingerprint: fingerprint(21) },
    { id: capability, fingerprint: fingerprint(22) },
    { id: operation, fingerprint: fingerprint(23) },
    { id: slot, fingerprint: fingerprint(24) },
  ],
};
const moduleId = ids.module('module:crm/handler');
const checkRequest = {
  abiVersion: { major: 1, minor: 0 },
  languageVersion: { major: 1, minor: 0 },
  registry,
  slotId: slot,
  source: { entry: moduleId, modules: [{ id: moduleId, source: [...new TextEncoder().encode(source)] }] },
  limits: STANDARD_COMPILE_LIMITS,
} as const;

function encoded(schema: Schema, value: unknown): readonly number[] {
  const result = encodeCanonical(schema, value, { registry: registry.schemas });
  if (!result.ok) throw new Error(result.failure.code);
  return [...result.value];
}

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
    abiVersion: { major: 1, minor: 0 },
    registry,
    slotId: slot,
    invocationId: ids.invocation(`invocation:${crypto.randomUUID().replaceAll('-', '')}`),
    program,
    input: encoded(ref(typeIds.event), input),
    limits,
    idempotencySeed: [1, 2, 3],
    trace: 'none',
  };
}

describe('direct RuntimeBridge walking skeleton', () => {
  it('derives behavior from checked source instead of fixture constants', async () => {
    const alternateSource = source.replace('2_000_000', '1_000_000').replace('Onboard ', 'Review ');
    const alternateCheck = {
      ...checkRequest,
      source: {
        entry: moduleId,
        modules: [{ id: moduleId, source: [...new TextEncoder().encode(alternateSource)] }],
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
            abiVersion: { major: 1, minor: 0 },
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
  });

  it('resolves host actions from the registry instead of a tasks.create special case', async () => {
    const notificationEffect = ids.effect('effect:notifications.send');
    const notificationCapability = ids.capability('capability:notifications.write');
    const notificationOperationId = ids.operation('operation:notifications.send');
    const notificationOperation = {
      ...(registry.operations[0] as ContractRegistry['operations'][number]),
      id: notificationOperationId,
      effect: notificationEffect,
      capability: notificationCapability,
    };
    const notificationSlot = {
      ...(registry.slots[0] as ContractRegistry['slots'][number]),
      effects: [notificationEffect],
      capabilities: [notificationCapability],
    };
    const notificationRegistry: ContractRegistry = {
      ...registry,
      digest: fingerprint(30),
      effects: [{ id: notificationEffect, fingerprint: fingerprint(31) }],
      capabilities: [{ id: notificationCapability, fingerprint: fingerprint(32) }],
      operations: [notificationOperation],
      slots: [notificationSlot],
      definitions: [
        ...definitions.map(({ id, fingerprint: value }) => ({ id, fingerprint: value })),
        { id: notificationEffect, fingerprint: fingerprint(31) },
        { id: notificationCapability, fingerprint: fingerprint(32) },
        { id: notificationOperationId, fingerprint: notificationOperation.fingerprint },
        { id: slot, fingerprint: notificationSlot.fingerprint },
      ],
    };
    const notificationSource = source.replace('ctx.tasks.create', 'ctx.notifications.send');
    const checked = await createDirectRuntimeBridge().check({
      ...checkRequest,
      registry: notificationRegistry,
      source: {
        entry: moduleId,
        modules: [{ id: moduleId, source: [...new TextEncoder().encode(notificationSource)] }],
      },
    });
    expect(checked.status).toBe('accepted');
    if (checked.status === 'accepted')
      expect(checked.summary).toEqual({ effects: [notificationEffect], capabilities: [notificationCapability] });
  });

  it('checks, executes one typed action, and verifies artifact mode', async () => {
    const bridge = createDirectRuntimeBridge();
    const checked = await bridge.check(checkRequest);
    expect(checked.status).toBe('accepted');
    if (checked.status !== 'accepted') return;
    expect(checked.diagnostics).toEqual([]);
    expect(checked.summary).toEqual({ effects: [effect], capabilities: [capability] });
    let calls = 0;
    const completed = await bridge.execute(executeRequest({ kind: 'artifact', bytes: checked.artifact }), {
      handleAction: async (request) => {
        calls++;
        expect(request.operationId).toBe(operation);
        expect(request.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
        return {
          abiVersion: { major: 1, minor: 0 },
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
  });

  it('takes no-action paths and maps policy rejection into the typed result', async () => {
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
    const rejected = await bridge.execute(executeRequest({ kind: 'source', source: checkRequest }), {
      handleAction: async (request) => ({
        abiVersion: { major: 1, minor: 0 },
        requestId: request.requestId,
        result: { tag: 'rejected', value: { code: 'denied' } },
      }),
    });
    expect(rejected.status).toBe('completed');
    if (rejected.status === 'completed')
      expect(decodeCanonicalResult(rejected.output)).toEqual({
        tag: 'error',
        value: { tag: 'policy', value: { code: 'denied' } },
      });
  });

  it('fails closed before dispatch for source, artifact, and resource violations', async () => {
    const bridge = createDirectRuntimeBridge();
    const ambient = {
      ...checkRequest,
      source: {
        entry: moduleId,
        modules: [{ id: moduleId, source: [...new TextEncoder().encode('import fs from "node:fs"')] }],
      },
    };
    expect((await bridge.check(ambient)).status).toBe('rejected');
    const checked = await bridge.check(checkRequest);
    if (checked.status !== 'accepted') throw new Error('fixture rejected');
    const corrupt = [...checked.artifact];
    corrupt[0] = 0;
    expect(
      (
        await bridge.execute(executeRequest({ kind: 'artifact', bytes: corrupt }), {
          handleAction: async () => {
            throw new Error('unreachable');
          },
        })
      ).status,
    ).toBe('not_started');
    const artifactText = decodeCanonical({ kind: 'string' }, Uint8Array.from(checked.artifact));
    if (!artifactText.ok || typeof artifactText.value !== 'string')
      throw new Error('artifact envelope is not canonical');
    const invalidCfg = encodeCanonical({ kind: 'string' }, artifactText.value.replace('b1:if-true', 'b999:missing'));
    if (!invalidCfg.ok) throw new Error('could not encode tampered artifact');
    expect(
      (
        await bridge.execute(executeRequest({ kind: 'artifact', bytes: [...invalidCfg.value] }), {
          handleAction: async () => {
            throw new Error('unreachable');
          },
        })
      ).status,
    ).toBe('not_started');
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
          abiVersion: { major: 1, minor: 0 },
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
                abiVersion: { major: 1, minor: 0 },
                requestId: request.requestId,
                result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'cancelled' } } },
              });
          }),
      },
    );
    while (!dispatched) await Promise.resolve();
    expect(await bridge.cancel({ abiVersion: { major: 1, minor: 0 }, invocationId })).toEqual({ status: 'accepted' });
    release?.();
    const cancelled = await pending;
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status === 'cancelled')
      expect(cancelled.facts.actions.map((record) => record.phase)).toEqual(['requested', 'resolved']);
  });
});

function decodeCanonicalResult(bytes: readonly number[]) {
  const result = decodeCanonical(resultSchema({ kind: 'unit' }, ref(typeIds.taskError)), Uint8Array.from(bytes), {
    registry: registry.schemas,
  });
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}
