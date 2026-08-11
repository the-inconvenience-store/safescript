import { afterEach, describe, expect, it } from 'bun:test';

import { type SemanticRevisionId } from '@safescript/contracts';

import { buildingStepTemplates, moveBuildingStep } from '../src/editor/composer.js';
import { createBuildingEditor } from '../src/runtime.js';

const open: ReturnType<typeof createBuildingEditor>[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((editor) => editor.close()));
});

describe('smart-building semantic editor', () => {
  it('opens checked source as a capability-derived React Flow document', async () => {
    const editor = createBuildingEditor();
    open.push(editor);

    const document = await editor.open();

    expect(document.acceptedSource.source).toContain('temperatureDelta');
    expect(document.graph.nodes.length).toBeGreaterThan(10);
    expect(document.flow.nodes.length).toBe(9);
    expect(document.flow.nodes.map(({ title }) => title)).toEqual([
      'Sensor event',
      'Comfort target',
      'Temperature delta',
      'HVAC rule',
      'Set HVAC',
      'Lighting rule',
      'Set lighting',
      'Record audit',
      'Successful result',
    ]);
    expect(document.flow.edges.length).toBeGreaterThan(3);
    expect(document.flow.nodes.every((node) => document.graph.nodes.some(({ id }) => id === node.semanticId))).toBe(
      true,
    );
    expect(
      document.flow.nodes.some((node) => node.controls.some(({ operation }) => operation === 'set_literal_value')),
    ).toBe(true);
    expect(document.flow.nodes.some((node) => node.ports.length > 0)).toBe(true);
  });

  it('accepts valid source drafts and rebuilds the semantic graph without changing the module', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const initial = await editor.open();

    const changed = await editor.submitSource(
      initial.acceptedSource.source.replace('temperatureDelta > 25n', 'temperatureDelta > 30n'),
    );

    expect(changed.status).toBe('accepted');
    if (changed.status !== 'accepted') throw new Error('visual edit was rejected');
    expect(changed.document.acceptedSource.source).toContain('temperatureDelta > 30n');
    expect(changed.document.acceptedSource.moduleId).toBe(initial.acceptedSource.moduleId);
    expect(changed.document.graph.semanticRevision).not.toBe(initial.graph.semanticRevision);
    expect(changed.document.graph.nodes.some((node) => node.constant === '30')).toBe(true);
  });

  it('advertises useful add-step templates and removable automation nodes', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const initial = await editor.open();

    const templates = buildingStepTemplates(initial);
    expect(templates.map(({ label }) => label)).toEqual(['Calculation', 'Humidity alert rule']);
    const rule = templates.find(({ id }) => id === 'humidity-alert');
    if (!rule) throw new Error('humidity rule template is missing');
    const added = await editor.applyIntent(rule.intent, initial.graph.semanticRevision);

    expect(added.status).toBe('accepted');
    if (added.status !== 'accepted') throw new Error('advertised rule insertion was rejected');
    expect(added.document.flow.nodes.map(({ title }) => title)).toContain('Send alert');
    expect(buildingStepTemplates(added.document)).toHaveLength(2);
    const addedRule = added.document.flow.nodes.find(({ title }) => title === 'Send alert rule');
    const remove = addedRule?.controls.find(({ operation }) => operation === 'delete_target');
    if (!remove) throw new Error('added rule is not visibly removable');
    const removed = await editor.applyIntent(
      { kind: 'delete_statement', target: remove.target },
      added.document.graph.semanticRevision,
    );
    expect(removed.status).toBe('accepted');
    if (removed.status !== 'accepted') throw new Error('advertised rule deletion was rejected');
    expect(removed.document.acceptedSource.source).not.toContain('high humidity');
  });

  it('moves a visible automation step through an advertised range destination', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const initial = await editor.open();
    const hvacRule = initial.flow.nodes.find(({ title }) => title === 'HVAC rule');
    if (!hvacRule) throw new Error('HVAC rule is missing');
    const intent = moveBuildingStep(initial, hvacRule, 'later');
    if (!intent) throw new Error('HVAC rule has no advertised later position');

    const moved = await editor.applyIntent(intent, initial.graph.semanticRevision);

    expect(moved.status).toBe('accepted');
    if (moved.status !== 'accepted') throw new Error('advertised move was rejected');
    expect(moved.document.acceptedSource.source.indexOf('event.lightLux')).toBeLessThan(
      moved.document.acceptedSource.source.indexOf('temperatureDelta > 25n'),
    );
  });

  it('translates a visual literal change into an advertised edit and adopts only checked source', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const initial = await editor.open();
    const literal = initial.graph.nodes.find((node) => node.constant === 'cool to 22C');
    if (!literal) throw new Error('fixture literal was not inspected');

    const changed = await editor.applyIntent(
      { kind: 'set_literal', target: literal.id, value: 'cool to 21C' },
      initial.graph.semanticRevision,
    );

    expect(changed.status).toBe('accepted');
    if (changed.status !== 'accepted') throw new Error('visual edit was rejected');
    expect(changed.document.acceptedSource.source).toContain('value: "cool to 21C"');
    expect(changed.document.acceptedSource.source).not.toContain('value: "cool to 22C"');
    expect(changed.diff.entries.some((entry) => entry.before.includes(literal.id))).toBe(true);
    expect(changed.document.graph.semanticRevision).toBe(changed.semanticRevision);
  });

  it('preserves the last accepted document across invalid, stale, and resource-limited edits and owns undo/redo', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const initial = await editor.open();
    const invalid = await editor.submitSource(initial.acceptedSource.source.replace('return Ok()', 'return Missing('));
    expect(invalid.status).toBe('rejected');
    if (invalid.status === 'accepted') throw new Error('invalid source was accepted');
    expect(invalid.document.acceptedSource.source).toBe(initial.acceptedSource.source);
    expect(invalid.diagnostics.length).toBeGreaterThan(0);

    const literal = initial.graph.nodes.find((node) => node.constant === 'cool to 22C');
    if (!literal) throw new Error('fixture literal was not inspected');
    const stale = await editor.applyIntent(
      { kind: 'set_literal', target: literal.id, value: 'stale' },
      `semantic-revision:${'0'.repeat(64)}` as SemanticRevisionId,
    );
    expect(stale).toMatchObject({ status: 'rejected', reason: 'stale_revision' });
    expect(stale.document.acceptedSource.source).toBe(initial.acceptedSource.source);

    const limited = await editor.applyIntent(
      { kind: 'set_literal', target: literal.id, value: 'limited' },
      initial.graph.semanticRevision,
      { diffBytes: 1 },
    );
    expect(limited).toMatchObject({
      status: 'rejected',
      reason: 'edit_limit_exceeded',
      limit: { limit: 'diff_bytes', maximum: 1 },
    });
    expect(limited.document.acceptedSource.source).toBe(initial.acceptedSource.source);

    const accepted = await editor.submitSource(initial.acceptedSource.source.replace('25n', '30n'));
    expect(accepted.status).toBe('accepted');
    expect(accepted.document.canUndo).toBe(true);
    const undone = await editor.undo();
    expect(undone.acceptedSource.source).toBe(initial.acceptedSource.source);
    expect(undone.canRedo).toBe(true);
    const redone = await editor.redo();
    expect(redone.acceptedSource.source).toContain('temperatureDelta > 30n');
  });

  it('checks and runs the accepted source with actions, results, traces, and bounded resource usage', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const document = await editor.open();

    const checked = await editor.check();
    expect(checked).toMatchObject({ status: 'accepted', diagnostics: [] });
    const completed = await editor.run();
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') return;
    expect(completed.output).toEqual({ tag: 'ok', value: null });
    expect(completed.facts.actions.map(({ phase }) => phase)).toEqual([
      'requested',
      'resolved',
      'requested',
      'resolved',
    ]);
    expect(completed.facts.trace.records.length).toBeGreaterThan(0);
    expect(completed.facts.usage).toMatchObject({ hostCalls: 2 });
    expect(document.acceptedSource.source).toBe((await editor.current()).acceptedSource.source);

    const limited = await editor.run({ hostCalls: 1 });
    expect(limited).toMatchObject({ status: 'failed', error: { code: 'resource_exhausted' } });
    expect((await editor.current()).acceptedSource.source).toBe(document.acceptedSource.source);
  });

  it('applies binding, condition, action, and structural controls through advertised operations', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    let document = await editor.open();
    const apply = async (intent: Parameters<typeof editor.applyIntent>[0]) => {
      const result = await editor.applyIntent(intent, document.graph.semanticRevision);
      expect(result.status).toBe('accepted');
      if (result.status !== 'accepted') throw new Error(`semantic operation ${intent.kind} was rejected`);
      document = result.document;
      return result;
    };
    const find = (predicate: (node: (typeof document.graph.nodes)[number]) => boolean) => {
      const node = document.graph.nodes.find(predicate);
      if (!node) throw new Error('expected current semantic node');
      return node;
    };

    await apply({
      kind: 'rename_symbol',
      target: find((node) => node.semanticKind === 'binding-pattern' && node.label === 'temperatureDelta').id,
      name: 'comfortDelta',
    });
    expect(document.acceptedSource.source).toContain('const comfortDelta =');

    await apply({
      kind: 'replace_condition',
      target: find((node) => node.semanticKind === 'binary' && node.operator === '>').id,
      source: 'comfortDelta >= 30n',
    });
    expect(document.acceptedSource.source).toContain('comfortDelta >= 30n');

    await apply({
      kind: 'change_action',
      target: find((node) => node.operationId === 'operation:hvac.set').id,
      operation: 'operation:alerts.send' as never,
    });
    expect(document.acceptedSource.source).toContain('ctx.alerts.send');
    await apply({
      kind: 'set_action_input',
      target: find((node) => node.operationId === 'operation:alerts.send').id,
      path: ['value'],
      source: 'event.zoneId',
    });
    expect(document.acceptedSource.source).toContain('value: event.zoneId');

    const body = find((node) => node.semanticKind === 'statement-container' && node.label === 'body');
    await apply({ kind: 'insert_statement', container: body.id, index: 2, source: 'const sampleCount = 1n' });
    expect(document.acceptedSource.source).toContain('const sampleCount = 1n');
    const inserted = find(
      (node) =>
        node.kind === 'statement' &&
        node.source !== undefined &&
        document.acceptedSource.source.slice(node.source.start, node.source.end).includes('sampleCount'),
    );
    await apply({ kind: 'delete_statement', target: inserted.id });
    expect(document.acceptedSource.source).not.toContain('sampleCount');

    const currentBody = find((node) => node.semanticKind === 'statement-container' && node.label === 'body');
    const children = document.graph.edges
      .filter((edge) => edge.kind === 'contains' && edge.from === currentBody.id && edge.index !== undefined)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(({ to }) => to);
    const reordered = [...children];
    [reordered[2], reordered[3]] = [reordered[3] as never, reordered[2] as never];
    await apply({ kind: 'reorder_statements', container: currentBody.id, children: reordered });
    expect(document.acceptedSource.source.indexOf('event.lightLux')).toBeLessThan(
      document.acceptedSource.source.indexOf('comfortDelta >= 30n'),
    );

    const movedBody = find((node) => node.semanticKind === 'statement-container' && node.label === 'body');
    const movedChildren = document.graph.edges
      .filter((edge) => edge.kind === 'contains' && edge.from === movedBody.id && edge.index !== undefined)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(({ to }) => to);
    const destination = document.graph.anchors.find(
      (anchor) => anchor.container === movedBody.id && anchor.index === 4,
    );
    if (!movedChildren[2] || !destination) throw new Error('move fixture is missing');
    const moved = await apply({
      kind: 'move_statement_range',
      container: movedBody.id,
      first: movedChildren[2],
      last: movedChildren[2],
      destination,
    });
    expect(moved.diff.entries.some(({ kind }) => kind === 'moved')).toBe(true);
  });
});
