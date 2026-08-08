import { afterEach, describe, expect, it } from 'bun:test';

import { ids } from '@safescript/contracts';

import { createFakeCrm } from '../app/fixture.js';
import { projectNodeEditor } from '../app/node-editor.js';
import { createFakeCrmWebApp } from '../app/server.js';
import { AUTOMATIONS } from '../fixtures/automations.js';

const open: ReturnType<typeof createFakeCrm>[] = [];
const fixture = () => {
  const crm = createFakeCrm();
  open.push(crm);
  return crm;
};
const automationAt = (index: number) => {
  const automation = AUTOMATIONS[index];
  if (!automation) throw new Error(`missing automation fixture ${index}`);
  return automation;
};
const automationNamed = (id: string) => {
  const automation = AUTOMATIONS.find((candidate) => candidate.id === id);
  if (!automation) throw new Error(`missing automation fixture ${id}`);
  return automation;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map(({ safe }) => safe.close()));
});

describe('fake CRM production-style integration', () => {
  it('checks and executes all ten automations with directly observable CRM effects', async () => {
    expect(AUTOMATIONS).toHaveLength(10);
    const crm = fixture();
    for (const automation of AUTOMATIONS) {
      const checked = await crm.safe.check({ slot: 'automation', source: automation.source });
      expect(checked.status, automation.id).toBe('accepted');
      const before = crm.store.effectCount();
      const result = await crm.run(automation);
      expect(result.status, automation.id).toBe('completed');
      expect(result.status === 'completed' && result.output).toEqual({ tag: 'ok', value: null });
      expect(crm.store.effectCount() - before, automation.id).toBe(automation.expectedOperations.length);
      if (result.status === 'completed') {
        expect(result.facts.actions.map(({ phase }) => phase)).toEqual(
          automation.expectedOperations.flatMap(() => ['requested', 'resolved']),
        );
        const requested = result.facts.actions
          .filter((record) => record.phase === 'requested')
          .map((record) => record.request.operationId);
        expect(requested).toEqual([...automation.expectedOperations]);
        for (const record of result.facts.actions) {
          if (record.phase !== 'requested') continue;
          expect(record.request.contractId).toBe(ids.contract('contract:fixture.fake-crm'));
          expect(record.request.idempotencyKey).toBeDefined();
          expect(record.request.source.module).toBe(automation.source.entryModule);
        }
      }
    }
    const state = crm.store.snapshot();
    expect(state.tasks).toHaveLength(2);
    expect(state.contactTags['contact-100']).toEqual(['vip', 'nurture']);
    expect(state.owners['deal-100']).toBe('owner-alex');
    expect(state.dealStages['deal-100']).toBe('qualified');
    expect(state.notifications).toHaveLength(2);
    expect(state.followups).toHaveLength(2);
    expect(state.notes).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it('derives every read-only editor node and edge from the compiler semantic graph', async () => {
    const crm = fixture();
    for (const automation of AUTOMATIONS) {
      const first = await crm.inspect(automation);
      const second = await crm.inspect(automation);
      expect(second).toEqual(first);
      const editor = projectNodeEditor(first);
      const graphIds = new Set(first.nodes.map(({ id }) => id));
      expect(editor.nodes.length).toBeGreaterThan(1);
      expect(editor.edges.length).toBeGreaterThan(0);
      expect(editor.nodes.every(({ id }) => graphIds.has(id as never))).toBe(true);
      expect(
        new Set(first.nodes.filter(({ kind }) => kind === 'action').map(({ operationId }) => operationId)),
      ).toEqual(new Set(automation.expectedOperations));
      expect(editor.edges.every(({ from, to }) => graphIds.has(from) && graphIds.has(to))).toBe(true);
    }
    const html = await crm.render();
    expect(html).toContain('READ ONLY · SEMANTIC GRAPH');
    expect(html).toContain('graph-viewport');
    expect(html).toContain('window.__CRM_AUTOMATIONS__');
    expect(html).toContain('CRM state');
  });

  it('reauthorises at runtime and exposes a typed policy error without mutating the CRM', async () => {
    const crm = fixture();
    const result = await crm.run(automationAt(0), {
      context: { actorId: 'outsider', workspaceIds: [] },
    });
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.output).toEqual({
      tag: 'error',
      value: {
        tag: 'policy',
        value: { code: 'crm_forbidden', detail: 'actor outsider cannot access this CRM resource' },
      },
    });
    expect(crm.store.effectCount()).toBe(0);
  });

  it('enforces a host-call limit between two real effects', async () => {
    const crm = fixture();
    const escalation = automationNamed('high-value-escalation');
    const result = await crm.run(escalation, { limits: { hostCalls: 1 } });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('resource_exhausted');
    expect(crm.store.snapshot().tasks).toHaveLength(1);
    expect(crm.store.snapshot().notifications).toHaveLength(0);
  });

  it('executes a checked artifact with the same observable effect as source', async () => {
    const crm = fixture();
    const automation = automationAt(4);
    const checked = await crm.safe.check({ slot: 'automation', source: automation.source });
    expect(checked.status).toBe('accepted');
    if (checked.status !== 'accepted') return;
    const result = await crm.safe.execute({
      slot: 'automation',
      program: { kind: 'artifact', bytes: checked.artifact },
      input: automation.input,
      context: crm.context,
      idempotencySeed: [9, 9, 9],
      invocationId: ids.invocation('invocation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    });
    expect(result.status).toBe('completed');
    expect(crm.store.snapshot().notes[0]?.value).toBe('Lost deal: Ada Lovelace');
  });

  it('uses the deterministic test API without touching production CRM handlers', async () => {
    const crm = fixture();
    const automation = automationAt(0);
    const report = await crm.safe.test({
      name: automation.id,
      slot: 'automation',
      program: { kind: 'source', source: automation.source },
      input: automation.input,
      actions: [
        {
          operation: 'createTask',
          input: { workspaceId: 'workspace-acme', entityId: 'deal-100', value: 'Onboard Ada Lovelace' },
          outcome: { tag: 'ok', value: { id: 'task-test' } },
        },
      ],
      expect: {
        status: 'completed',
        output: { tag: 'ok', value: null },
        effects: [ids.effect('effect:tasks.create')],
      },
    });
    expect(report.passed).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(crm.store.effectCount()).toBe(0);
  });

  it('covers canonical no-action branches and rejects ambient authority at compile time', async () => {
    const crm = fixture();
    const won = automationAt(0);
    for (const input of [
      { ...won.input, amountMinor: 1_999_999n },
      { ...won.input, previousStage: 'won' },
      { ...won.input, currency: 'USD' },
    ]) {
      const result = await crm.run(won, { input });
      expect(result.status).toBe('completed');
      expect(result.status === 'completed' && result.output).toEqual({ tag: 'ok', value: null });
    }
    expect(crm.store.effectCount()).toBe(0);

    const module = won.source.modules[0];
    if (!module) throw new Error('missing source module');
    const rejected = await crm.safe.check({
      slot: 'automation',
      source: {
        entryModule: won.source.entryModule,
        modules: [{ ...module, source: `import { readFile } from "node:fs"\n${module.source}` }],
      },
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.status === 'rejected' && rejected.diagnostics.length).toBeGreaterThan(0);
  });

  it('bounds graph export independently and fails closed on malformed trusted-host output', async () => {
    const crm = fixture();
    const automation = automationAt(0);
    const bounded = await crm.safe.inspect({
      slot: 'automation',
      source: automation.source,
      views: ['semantic_graph'],
      graphLimits: { nodes: 1, edges: 1, bytes: 32 },
    });
    expect(bounded.status).toBe('accepted');
    expect(bounded.status === 'accepted' && bounded.views.semantic_graph).toBeUndefined();
    expect(bounded.status === 'accepted' && bounded.viewErrors.semantic_graph?.code).toBe('graph_limit_exceeded');

    const malformed = createFakeCrm(undefined, {
      mapHandlerResult: (operation, result) => (operation === 'createTask' ? { surprise: result } : result),
    });
    open.push(malformed);
    const failed = await malformed.run(automation);
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.error.code).toBe('invalid_result');
  });

  it('serves the interactive editor and runs or resets one automation through HTTP', async () => {
    const app = createFakeCrmWebApp();
    try {
      const page = await app.fetch(new Request('http://fixture.test/'));
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain('id="run-script"');
      expect(html).toContain('id="graph-stage"');
      expect(html).not.toContain('createFakeCrmWebApp');

      const run = await app.fetch(new Request('http://fixture.test/api/run/won-onboarding-task', { method: 'POST' }));
      const result = (await run.json()) as {
        readonly status: string;
        readonly actions: readonly Readonly<{ operationId: string; effectId: string; outcome: string }>[];
        readonly state: Readonly<{ tasks: readonly Readonly<{ value: string }>[] }>;
      };
      expect(run.status).toBe(200);
      expect(result.status).toBe('completed');
      expect(result.actions).toEqual([
        { operationId: 'operation:tasks.create', effectId: 'effect:tasks.create', outcome: 'completed' },
      ]);
      expect(result.state.tasks[0]?.value).toBe('Onboard Ada Lovelace');

      const reset = await app.fetch(new Request('http://fixture.test/api/reset', { method: 'POST' }));
      const resetResult = (await reset.json()) as { readonly state: Readonly<{ tasks: readonly unknown[] }> };
      expect(resetResult.state.tasks).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
