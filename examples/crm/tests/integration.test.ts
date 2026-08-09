import { afterEach, describe, expect, it } from 'bun:test';

import { ids } from '@safescript/contracts';

import { AUTOMATIONS } from '../src/automations.js';
import { projectNodeEditor } from '../src/graph/project.js';
import { createCrm } from '../src/runtime.js';
import { createCrmWebApp } from '../src/web/server.js';

const open: ReturnType<typeof createCrm>[] = [];
const example = () => {
  const crm = createCrm();
  open.push(crm);
  return crm;
};
const automationAt = (index: number) => {
  const automation = AUTOMATIONS[index];
  if (!automation) throw new Error(`missing automation example ${index}`);
  return automation;
};
const automationNamed = (id: string) => {
  const automation = AUTOMATIONS.find((candidate) => candidate.id === id);
  if (!automation) throw new Error(`missing automation example ${id}`);
  return automation;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map(({ safe }) => safe.close()));
});

describe('CRM example integration', () => {
  it('checks and executes all ten automations with directly observable CRM effects', async () => {
    expect(AUTOMATIONS).toHaveLength(10);
    expect(new Set(AUTOMATIONS.map(({ input }) => input.workspaceId))).toEqual(new Set(['workspace-acme']));
    expect(new Set(AUTOMATIONS.map(({ input }) => input.dealId))).toEqual(new Set(['deal-100']));
    expect(new Set(AUTOMATIONS.map(({ input }) => input.contactId))).toEqual(new Set(['contact-100']));
    const crm = example();
    const initial = crm.store.snapshot();
    expect(initial.workspace).toEqual({ id: 'workspace-acme', name: 'Acme Research' });
    expect(initial.deals['deal-100']).toMatchObject({
      contactId: 'contact-100',
      ownerId: 'owner-riley',
      stage: 'qualified',
      amountMinor: 2_500_000,
    });
    expect(initial.contacts['contact-100']).toMatchObject({ name: 'Ada Lovelace', tags: ['prospect'] });
    expect(initial.owners['owner-alex']?.name).toBe('Alex Morgan');
    expect(initial.recentEvents).toEqual([]);
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
          expect(record.request.contractId).toBe(ids.contract('contract:example.crm'));
          expect(record.request.idempotencyKey).toBeDefined();
          expect(record.request.source.module).toBe(automation.source.entryModule);
        }
      }
    }
    const state = crm.store.snapshot();
    expect(state.tasks).toHaveLength(2);
    expect(state.contacts['contact-100']?.tags).toEqual(['prospect', 'vip', 'nurture']);
    expect(state.deals['deal-100']?.ownerId).toBe('owner-alex');
    expect(state.deals['deal-100']?.stage).toBe('qualified');
    expect(state.notifications).toHaveLength(2);
    expect(state.followups).toHaveLength(2);
    expect(state.notes).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it('derives every read-only editor node and edge from the compiler semantic graph', async () => {
    const crm = example();
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
      for (const action of editor.nodes.filter(({ kind }) => kind === 'action')) {
        expect(
          editor.edges.some(({ from, to }) => from === action.id || to === action.id),
          automation.id,
        ).toBe(true);
      }
    }
    const wonGraph = await crm.inspect(automationNamed('won-onboarding-task'));
    const wonEditor = projectNodeEditor(wonGraph);
    expect(wonEditor.nodes.find(({ title }) => title === 'IF')?.detail).toContain('previousStage === "won"');
    expect(wonEditor.nodes.find(({ title }) => title === 'tasks.create')?.detail).toBe(
      '{ workspaceId: event.workspaceId, entityId: event.dealId, value: `Onboard ${event.name}` }',
    );
    expect(wonEditor.nodes.filter(({ kind }) => kind === 'return').map(({ detail }) => detail)).toEqual([
      'Ok()',
      'Err(result.value)',
      'Ok()',
    ]);
    const html = await crm.render();
    expect(html).toContain('READ ONLY · SEMANTIC GRAPH');
    expect(html).toContain('graph-viewport');
    expect(html).toContain('window.__CRM_AUTOMATIONS__');
    expect(html).toContain('CRM state');
    expect(html).toContain('Selected event');
    expect(html).toContain('Acme Research');
  });

  it('enforces a host-call limit between two real effects', async () => {
    const crm = example();
    const escalation = automationNamed('high-value-escalation');
    const result = await crm.run(escalation, { limits: { hostCalls: 1 } });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('resource_exhausted');
    expect(crm.store.snapshot().tasks).toHaveLength(1);
    expect(crm.store.snapshot().notifications).toHaveLength(0);
  });

  it('executes a checked artifact with the same observable effect as source', async () => {
    const crm = example();
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
    const crm = example();
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
    const crm = example();
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
    const crm = example();
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

    const malformed = createCrm(undefined, {
      mapHandlerResult: (operation, result) => (operation === 'createTask' ? { surprise: result } : result),
    });
    open.push(malformed);
    const failed = await malformed.run(automation);
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.error.code).toBe('invalid_result');
  });

  it('serves the interactive editor and runs or resets one automation through HTTP', async () => {
    const app = createCrmWebApp();
    try {
      const page = await app.fetch(new Request('http://fixture.test/'));
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain('id="run-script"');
      expect(html).toContain('id="graph-stage"');
      expect(html).not.toContain('createCrmWebApp');

      const run = await app.fetch(new Request('http://fixture.test/api/run/won-onboarding-task', { method: 'POST' }));
      const result = (await run.json()) as {
        readonly status: string;
        readonly actions: readonly Readonly<{ operationId: string; effectId: string; outcome: string }>[];
        readonly state: Readonly<{
          deals: Readonly<Record<string, Readonly<{ contactId: string; stage: string }>>>;
          recentEvents: readonly Readonly<{ automationId: string; dealId: string; stage: string }>[];
          tasks: readonly Readonly<{ entityId: string; value: string }>[];
        }>;
      };
      expect(run.status).toBe(200);
      expect(result.status).toBe('completed');
      expect(result.actions).toEqual([
        { operationId: 'operation:tasks.create', effectId: 'effect:tasks.create', outcome: 'completed' },
      ]);
      expect(result.state.deals['deal-100']?.contactId).toBe('contact-100');
      expect(result.state.deals['deal-100']?.stage).toBe('won');
      expect(result.state.recentEvents[0]).toMatchObject({
        automationId: 'won-onboarding-task',
        dealId: 'deal-100',
        stage: 'won',
      });
      expect(result.state.tasks[0]?.entityId).toBe('deal-100');
      expect(result.state.tasks[0]?.value).toBe('Onboard Ada Lovelace');

      const reset = await app.fetch(new Request('http://fixture.test/api/reset', { method: 'POST' }));
      const resetResult = (await reset.json()) as {
        readonly state: Readonly<{
          deals: Readonly<Record<string, Readonly<{ ownerId: string; stage: string }>>>;
          contacts: Readonly<Record<string, Readonly<{ tags: readonly string[] }>>>;
          recentEvents: readonly unknown[];
          tasks: readonly unknown[];
        }>;
      };
      expect(resetResult.state.tasks).toEqual([]);
      expect(resetResult.state.deals['deal-100']).toMatchObject({ ownerId: 'owner-riley', stage: 'qualified' });
      expect(resetResult.state.contacts['contact-100']?.tags).toEqual(['prospect']);
      expect(resetResult.state.recentEvents).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
