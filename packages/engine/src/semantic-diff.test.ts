import { describe, expect, it } from 'bun:test';

import {
  derivedSemanticNodeId,
  ids,
  type SemanticChangedRegion,
  type SemanticEdit,
  type SemanticEditId,
  type SemanticGraph,
  type SemanticGraphNode,
  type SemanticNodeKind,
  type SemanticNodeSemanticKind,
} from '@safescript/contracts';

import { buildSemanticDiff } from './semantic-diff.js';

const moduleId = ids.module('module:test.semantic-diff');
const encoder = new TextEncoder();
const id = (value: string) => derivedSemanticNodeId(encoder.encode(value));
const editId = (value: string) => `edit:${value}` as SemanticEditId;
const node = (
  value: string,
  start: number,
  end: number,
  kind: SemanticNodeKind,
  semanticKind: SemanticNodeSemanticKind,
): SemanticGraphNode => ({
  id: id(value),
  kind,
  semanticKind,
  source: { module: moduleId, start, end },
  editable: { module: moduleId, start, end },
});
const graph = (nodes: readonly SemanticGraphNode[]) => ({ nodes }) as unknown as SemanticGraph;
const region = (
  edit: SemanticEditId,
  original: readonly [number, number],
  updated: readonly [number, number],
): SemanticChangedRegion => ({
  editIds: [edit],
  original: { module: moduleId, start: original[0], end: original[1] },
  updated: { module: moduleId, start: updated[0], end: updated[1] },
});

describe('semantic diff correlation', () => {
  it('classifies every identity relation deterministically', () => {
    const rename = editId('rename');
    const move = editId('move');
    const update = editId('update');
    const split = editId('split');
    const merge = editId('merge');
    const destination = { container: id('container'), index: 0 };
    const edits: readonly SemanticEdit[] = [
      { kind: 'rename_symbol', editId: rename, target: id('rename:old'), newName: 'next', preconditions: [] },
      { kind: 'move_target', editId: move, target: id('move:old'), destination, preconditions: [] },
      {
        kind: 'replace_target',
        editId: update,
        target: id('update:old'),
        replacement: { category: 'expression', source: [49] },
        preconditions: [],
      },
      {
        kind: 'replace_target',
        editId: split,
        target: id('split:old'),
        replacement: { category: 'statement_list', source: [49] },
        preconditions: [],
      },
      {
        kind: 'replace_target',
        editId: merge,
        target: id('merge:old:1'),
        replacement: { category: 'expression', source: [49] },
        preconditions: [],
      },
    ];
    const preserved = node('preserved', 90, 91, 'expression', 'name');
    const preservedInsideRename = node('preserved:inside-rename', 0, 1, 'expression', 'name');
    const removed = node('removed', 92, 93, 'constant', 'literal');
    const added = node('added', 94, 95, 'constant', 'literal');
    const before = graph([
      node('rename:old', 0, 1, 'binding', 'symbol'),
      preservedInsideRename,
      node('move:old', 10, 11, 'statement', 'return'),
      node('update:old', 20, 21, 'expression', 'binary'),
      node('split:old', 30, 31, 'statement', 'return'),
      node('merge:old:1', 40, 41, 'constant', 'literal'),
      node('merge:old:2', 41, 42, 'constant', 'literal'),
      preserved,
      removed,
    ]);
    const after = graph([
      node('rename:new', 0, 2, 'binding', 'symbol'),
      preservedInsideRename,
      node('move:new', 10, 11, 'statement', 'return'),
      node('update:new', 20, 22, 'expression', 'binary'),
      node('split:new:1', 30, 31, 'statement', 'return'),
      node('split:new:2', 31, 32, 'statement', 'return'),
      node('merge:new', 40, 42, 'constant', 'literal'),
      preserved,
      added,
    ]);
    const regions = [
      region(rename, [0, 1], [0, 2]),
      region(move, [10, 11], [10, 11]),
      region(update, [20, 21], [20, 22]),
      region(split, [30, 31], [30, 32]),
      region(merge, [40, 42], [40, 42]),
    ];

    const first = buildSemanticDiff(before, after, edits, regions);
    const second = buildSemanticDiff(before, after, edits, regions);

    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.kind)).toEqual([
      'renamed',
      'moved',
      'updated',
      'split',
      'merged',
      'preserved',
      'preserved',
      'removed',
      'added',
    ]);
    expect(first.entries.find((entry) => entry.kind === 'renamed')).toMatchObject({
      before: [id('rename:old')],
      after: [id('rename:new')],
      editIds: [rename],
    });
    expect(first.entries).toContainEqual({
      kind: 'preserved',
      before: [preservedInsideRename.id],
      after: [preservedInsideRename.id],
      editIds: [],
    });
    expect(first.entries.find((entry) => entry.kind === 'split')).toMatchObject({
      before: [id('split:old')],
      after: [id('split:new:1'), id('split:new:2')],
      editIds: [split],
    });
    expect(first.entries.find((entry) => entry.kind === 'merged')).toMatchObject({
      before: [id('merge:old:1'), id('merge:old:2')],
      after: [id('merge:new')],
      editIds: [merge],
    });
  });
});
