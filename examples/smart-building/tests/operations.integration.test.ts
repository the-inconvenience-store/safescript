import { afterEach, describe, expect, it } from 'bun:test';

import { ids, type SemanticEditId } from '@safescript/contracts';

import { translateSemanticIntent, type SemanticIntent } from '../src/editor/operations.js';
import { createBuildingEditor } from '../src/runtime.js';

const open: ReturnType<typeof createBuildingEditor>[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((editor) => editor.close()));
});

describe('semantic operation translation', () => {
  it('covers the useful visual intents using only advertised capability inputs', async () => {
    const editor = createBuildingEditor();
    open.push(editor);
    const document = await editor.open();
    const node = (predicate: (node: (typeof document.graph.nodes)[number]) => boolean) => {
      const match = document.graph.nodes.find(predicate);
      if (!match) throw new Error('expected semantic fixture node');
      return match;
    };
    const body = node((candidate) => candidate.semanticKind === 'statement-container' && candidate.label === 'body');
    const statements = document.graph.edges
      .filter((edge) => edge.kind === 'contains' && edge.from === body.id && edge.index !== undefined)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(({ to }) => to);
    const destination = document.graph.anchors.find((anchor) => anchor.container === body.id && anchor.index === 2);
    if (!destination || !statements[0] || !statements[1]) throw new Error('fixture statement anchors are missing');
    const action = node((candidate) => candidate.operationId === ids.operation('operation:hvac.set'));
    const intents: readonly SemanticIntent[] = [
      {
        kind: 'rename_symbol',
        target: node((candidate) => candidate.label === 'temperatureDelta').id,
        name: 'comfortDelta',
      },
      {
        kind: 'replace_condition',
        target: node((candidate) => candidate.semanticKind === 'binary' && candidate.operator === '>').id,
        source: 'temperatureDelta >= 30n',
      },
      {
        kind: 'change_operator',
        target: node((candidate) => candidate.semanticKind === 'binary' && candidate.operator === '>').id,
        operator: '>=',
      },
      { kind: 'insert_statement', container: body.id, index: 2, source: 'const sampleCount = 1n' },
      { kind: 'delete_statement', target: statements[0] },
      { kind: 'reorder_statements', container: body.id, children: [...statements].reverse() },
      {
        kind: 'move_statement_range',
        container: body.id,
        first: statements[0],
        last: statements[1],
        destination,
      },
      {
        kind: 'change_action',
        target: action.id,
        operation: ids.operation('operation:alerts.send'),
      },
      { kind: 'set_action_input', target: action.id, path: ['value'], source: '"comfort warning"' },
    ];

    const operations = intents.map((intent, index) =>
      translateSemanticIntent(
        document.graph,
        document.capabilities,
        intent,
        `edit:translation-${index}` as SemanticEditId,
      ),
    );

    expect(operations.map(({ kind }) => kind)).toEqual([
      'rename_symbol',
      'replace_target',
      'change_operator',
      'insert_at_anchor',
      'delete_target',
      'reorder_children',
      'move_statement_range',
      'change_action_operation',
      'set_action_input_field',
    ]);
    expect(operations.every(({ preconditions }) => preconditions.length > 0)).toBe(true);
    expect(operations[7]).toMatchObject({
      fieldMappings: [
        { from: ['buildingId'], to: ['buildingId'] },
        { from: ['zoneId'], to: ['zoneId'] },
        { from: ['value'], to: ['value'] },
      ],
      requiredInputs: [],
    });
  });
});
