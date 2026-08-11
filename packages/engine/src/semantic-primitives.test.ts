import { describe, expect, it } from 'bun:test';

import {
  LANGUAGE_PROFILE,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  type CompilerVersion,
  type ContractId,
  type ModuleId,
  type ProgramHash,
  type SemanticEdit,
  type SemanticGraph,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SemanticRevisionId,
  type Sha256Digest,
  type SlotId,
  type SourceHash,
  type SourceProgram,
} from '@safescript/contracts';

import { applyPrimitiveSemanticEdits, primitiveEditCoverage } from './semantic-primitives.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const digest = '1'.repeat(64) as Sha256Digest;
const revision = `semantic-revision:${'2'.repeat(64)}` as SemanticRevisionId;
const id = (digit: string) => `semantic-node:${digit.repeat(64)}` as SemanticNodeId;
const moduleId = 'module:primitive.test' as ModuleId;
const container = id('1');
const first = id('2');
const firstBinding = id('3');
const firstReference = id('4');
const literal = id('5');
const second = id('6');
const returned = id('7');

function rangeIn(source: string, selected: string, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = source.indexOf(selected, offset + 1);
  const start = encoder.encode(source.slice(0, offset)).length;
  return { module: moduleId, start, end: start + encoder.encode(selected).length };
}

const source = ['const first = 1;', 'const second = first + 1;', 'return Ok(second);', ''].join('\n');
const range = (selected: string, occurrence = 0) => rangeIn(source, selected, occurrence);
const sourceProgram: SourceProgram = { module: moduleId, source: Array.from(encoder.encode(source)) };
const node = (
  nodeId: SemanticNodeId,
  kind: SemanticGraphNode['kind'],
  semanticKind: SemanticGraphNode['semanticKind'],
  selected: string,
  occurrence = 0,
  facts: Partial<SemanticGraphNode> = {},
): SemanticGraphNode => ({
  id: nodeId,
  kind,
  semanticKind,
  source: range(selected, occurrence),
  editable: range(selected, occurrence),
  ...facts,
});

const graph: SemanticGraph = {
  schema: SEMANTIC_GRAPH_SCHEMA,
  semanticRevision: revision,
  sourceHash: digest as unknown as SourceHash,
  programHash: digest as unknown as ProgramHash,
  compiler: { build: 'test' } as CompilerVersion,
  language: LANGUAGE_PROFILE,
  contract: { id: 'contract:primitive.test' as ContractId, digest },
  slotId: 'slot:primitive.test' as SlotId,
  moduleId,
  root: id('0'),
  nodes: [
    node(id('0'), 'module', 'module', source),
    node(container, 'container', 'statement-container', source),
    node(first, 'statement', 'variable', 'const first = 1;'),
    node(firstBinding, 'binding', 'symbol', 'first', 0, { label: 'first' }),
    node(firstReference, 'expression', 'name', 'first', 1, { label: 'first' }),
    node(literal, 'constant', 'literal', '1', 0, { constant: 1 }),
    node(second, 'statement', 'variable', 'const second = first + 1;'),
    node(returned, 'statement', 'return', 'return Ok(second);'),
  ],
  edges: [
    { kind: 'contains', from: container, to: first, index: 0 },
    { kind: 'contains', from: container, to: second, index: 1 },
    { kind: 'contains', from: container, to: returned, index: 2 },
    { kind: 'binds', from: first, to: firstBinding, role: 'binding' },
    { kind: 'references', from: firstReference, to: firstBinding, role: 'binding' },
  ],
  anchors: [
    { container, index: 0, before: first },
    { container, index: 1, before: second, after: first },
    { container, index: 2, before: returned, after: second },
    { container, index: 3, after: returned },
  ],
  operations: [],
  resources: {
    declarations: 0,
    expressions: 2,
    controlPoints: 3,
    actionSites: 0,
    potentialEffectCost: 0,
    declarationNodes: [],
    expressionNodes: [firstReference, literal],
    controlNodes: [first, second, returned],
    actionNodes: [],
  },
};

function apply(edit: SemanticEdit) {
  return applyPrimitiveSemanticEdits(sourceProgram, graph, revision, [edit], STANDARD_SEMANTIC_EDIT_LIMITS);
}

function acceptedText(result: ReturnType<typeof apply>): string {
  if (result.status !== 'accepted') throw new Error(`edit rejected: ${result.reason}`);
  return decoder.decode(Uint8Array.from(result.source.source));
}

function anchor(index: number) {
  const selected = graph.anchors[index];
  if (!selected) throw new Error(`missing test anchor ${index}`);
  return selected;
}

describe('six primitive semantic edits', () => {
  it('renames one resolved symbol binding and every reference', () => {
    const result = apply({
      kind: 'rename_symbol',
      editId: 'edit:rename' as never,
      target: firstBinding,
      newName: 'renamed',
      preconditions: [{ kind: 'old_name', value: 'first' }],
    });
    expect(acceptedText(result)).toBe(source.replaceAll('first', 'renamed'));
    expect(result).toMatchObject({ status: 'accepted', outcomes: [{ editId: 'edit:rename' }] });
  });

  it('replaces one category-compatible target with a locally printed fragment', () => {
    const result = apply({
      kind: 'replace_target',
      editId: 'edit:replace' as never,
      target: literal,
      replacement: { category: 'expression', source: Array.from(encoder.encode('2+3')) },
      preconditions: [{ kind: 'old_literal', value: 1 }],
    });
    expect(acceptedText(result)).toContain('const first = 2 + 3;');
  });

  it('inserts at an exact structural anchor', () => {
    const destination = anchor(1);
    const result = apply({
      kind: 'insert_at_anchor',
      editId: 'edit:insert' as never,
      anchor: destination,
      fragment: { category: 'statement', source: Array.from(encoder.encode('const inserted = 3;')) },
      preconditions: [{ kind: 'expected_anchor', value: destination }],
    });
    expect(acceptedText(result)).toContain('const first = 1;\nconst inserted = 3;\nconst second');
  });

  it('resolves and formats empty structural anchors by container grammar', () => {
    const cases = [
      {
        semanticKind: 'parameter-container' as const,
        original: 'function f() {}',
        fragment: { category: 'parameter' as const, text: 'value: number' },
        expected: 'function f(value: number) {}',
      },
      {
        semanticKind: 'argument-container' as const,
        original: 'call()',
        fragment: { category: 'argument' as const, text: 'value' },
        expected: 'call(value)',
      },
      {
        semanticKind: 'type-parameter-container' as const,
        original: 'function f() {}',
        fragment: { category: 'type' as const, text: 'T' },
        expected: 'function f<T>() {}',
      },
      {
        semanticKind: 'template-container' as const,
        original: '`safe`',
        fragment: { category: 'expression' as const, text: 'value' },
        expected: '`safe${value}`',
      },
      {
        semanticKind: 'initializer-container' as const,
        original: 'for (; ok; tick()) {}',
        fragment: { category: 'expression' as const, text: 'start()' },
        expected: 'for (start(); ok; tick()) {}',
      },
      {
        semanticKind: 'increment-container' as const,
        original: 'for (; ok;) {}',
        fragment: { category: 'expression' as const, text: 'tick()' },
        expected: 'for (; ok;tick()) {}',
      },
      {
        semanticKind: 'statement-container' as const,
        original: 'function f() {}',
        fragment: { category: 'statement' as const, text: 'return;' },
        expected: 'function f() {\n  return;\n}',
      },
    ];
    const containerDigits = ['8', '9', 'a', 'b', 'c', 'd', 'e'] as const;
    for (const [index, selected] of cases.entries()) {
      const selectedContainer = id(containerDigits[index] as string);
      const program: SourceProgram = {
        module: moduleId,
        source: Array.from(encoder.encode(selected.original)),
      };
      const whole = rangeIn(selected.original, selected.original);
      const selectedAnchor = { container: selectedContainer, index: 0 } as const;
      const selectedGraph: SemanticGraph = {
        ...graph,
        root: id('0'),
        nodes: [
          { id: id('0'), kind: 'module', semanticKind: 'module', source: whole, editable: whole },
          {
            id: selectedContainer,
            kind: 'container',
            semanticKind: selected.semanticKind,
            source: whole,
            editable: whole,
          },
        ],
        edges: [{ kind: 'contains', from: id('0'), to: selectedContainer }],
        anchors: [selectedAnchor],
      };
      const result = applyPrimitiveSemanticEdits(
        program,
        selectedGraph,
        revision,
        [
          {
            kind: 'insert_at_anchor',
            editId: `edit:empty-${index}` as never,
            anchor: selectedAnchor,
            fragment: {
              category: selected.fragment.category,
              source: Array.from(encoder.encode(selected.fragment.text)),
            },
            preconditions: [{ kind: 'expected_anchor', value: selectedAnchor }],
          },
        ],
        STANDARD_SEMANTIC_EDIT_LIMITS,
      );
      expect(acceptedText(result), selected.semanticKind).toBe(selected.expected);
    }
  });

  it('inserts one checked variable declaration into an existing declaration list', () => {
    const original = 'const first = 1;\n';
    const program: SourceProgram = { module: moduleId, source: Array.from(encoder.encode(original)) };
    const selectedContainer = id('b');
    const declaration = id('c');
    const whole = rangeIn(original, original);
    const declarationRange = rangeIn(original, 'first = 1');
    const selectedAnchor = { container: selectedContainer, index: 1, after: declaration } as const;
    const selectedGraph: SemanticGraph = {
      ...graph,
      nodes: [
        { id: id('0'), kind: 'module', semanticKind: 'module', source: whole, editable: whole },
        {
          id: selectedContainer,
          kind: 'container',
          semanticKind: 'declaration-container',
          source: whole,
          editable: whole,
        },
        {
          id: declaration,
          kind: 'binding',
          semanticKind: 'binding-pattern',
          source: declarationRange,
          editable: declarationRange,
          label: 'first',
        },
      ],
      edges: [{ kind: 'contains', from: selectedContainer, to: declaration, index: 0 }],
      anchors: [selectedAnchor],
    };
    const result = applyPrimitiveSemanticEdits(
      program,
      selectedGraph,
      revision,
      [
        {
          kind: 'insert_at_anchor',
          editId: 'edit:declaration-list' as never,
          anchor: selectedAnchor,
          fragment: { category: 'declaration', source: Array.from(encoder.encode('const second = 2;')) },
          preconditions: [{ kind: 'expected_anchor', value: selectedAnchor }],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(acceptedText(result)).toBe('const first = 1, second = 2;\n');
  });

  it('deletes one target under explicit comment ownership policy', () => {
    const result = apply({
      kind: 'delete_target',
      editId: 'edit:delete' as never,
      target: first,
      commentPolicy: 'preserve_owned_comments',
      preconditions: [{ kind: 'target_semantic_kind', value: 'variable' }],
    });
    expect(acceptedText(result)).not.toContain('const first = 1;');
  });

  it('moves one complete source slice to another container gap', () => {
    const destination = anchor(3);
    const result = apply({
      kind: 'move_target',
      editId: 'edit:move' as never,
      target: first,
      destination,
      preconditions: [
        { kind: 'expected_parent', value: container },
        { kind: 'expected_anchor', value: destination },
      ],
    });
    expect(acceptedText(result)).toBe(
      ['const second = first + 1;', 'return Ok(second);', 'const first = 1;', ''].join('\n'),
    );
  });

  it('reorders the complete child set of one structural container', () => {
    const result = apply({
      kind: 'reorder_children',
      editId: 'edit:reorder' as never,
      container,
      children: [returned, first, second],
      preconditions: [],
    });
    expect(acceptedText(result)).toBe(
      ['return Ok(second);', 'const first = 1;', 'const second = first + 1;', ''].join('\n'),
    );
  });

  it('reorders inline children while preserving the original separators and trivia slots', () => {
    const inline = 'call(first, /* gap */ second);\n';
    const inlineSource: SourceProgram = { module: moduleId, source: Array.from(encoder.encode(inline)) };
    const inlineContainer = id('8');
    const left = id('9');
    const right = id('a');
    const inlineGraph: SemanticGraph = {
      ...graph,
      nodes: [
        node(id('0'), 'module', 'module', source),
        {
          id: inlineContainer,
          kind: 'container',
          semanticKind: 'argument-container',
          source: rangeIn(inline, inline),
          editable: rangeIn(inline, inline),
        },
        {
          id: left,
          kind: 'expression',
          semanticKind: 'name',
          source: rangeIn(inline, 'first'),
          editable: rangeIn(inline, 'first'),
          label: 'first',
        },
        {
          id: right,
          kind: 'expression',
          semanticKind: 'name',
          source: rangeIn(inline, 'second'),
          editable: rangeIn(inline, 'second'),
          label: 'second',
        },
      ],
      edges: [
        { kind: 'contains', from: inlineContainer, to: left, index: 0 },
        { kind: 'contains', from: inlineContainer, to: right, index: 1 },
      ],
      anchors: [],
    };
    const result = applyPrimitiveSemanticEdits(
      inlineSource,
      inlineGraph,
      revision,
      [
        {
          kind: 'reorder_children',
          editId: 'edit:inline-reorder' as never,
          container: inlineContainer,
          children: [right, left],
          preconditions: [],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(acceptedText(result)).toBe('call(second, /* gap */ first);\n');
  });

  it('honors both explicit deletion policies for an owned comment', () => {
    const prefix = '// owned by first\n';
    const delta = encoder.encode(prefix).length;
    const commentedSource: SourceProgram = {
      module: moduleId,
      source: Array.from(encoder.encode(prefix + source)),
    };
    const shiftedGraph: SemanticGraph = {
      ...graph,
      nodes: graph.nodes.map((selected) => ({
        ...selected,
        ...(selected.source
          ? {
              source: {
                ...selected.source,
                start: selected.kind === 'module' || selected.kind === 'container' ? 0 : selected.source.start + delta,
                end: selected.source.end + delta,
              },
            }
          : {}),
        ...(selected.editable
          ? {
              editable: {
                ...selected.editable,
                start:
                  selected.kind === 'module' || selected.kind === 'container' ? 0 : selected.editable.start + delta,
                end: selected.editable.end + delta,
              },
            }
          : {}),
      })),
    };
    const remove = (commentPolicy: 'delete_owned_comments' | 'preserve_owned_comments') =>
      applyPrimitiveSemanticEdits(
        commentedSource,
        shiftedGraph,
        revision,
        [
          {
            kind: 'delete_target',
            editId: `edit:${commentPolicy}` as never,
            target: first,
            commentPolicy,
            preconditions: [{ kind: 'owned_comments', value: true }],
          },
        ],
        STANDARD_SEMANTIC_EDIT_LIMITS,
      );
    expect(acceptedText(remove('preserve_owned_comments'))).toContain('// owned by first');
    expect(acceptedText(remove('delete_owned_comments'))).not.toContain('// owned by first');
  });

  it('rejects a category-valid fragment when the complete transformed program fails checking', () => {
    const result = applyPrimitiveSemanticEdits(
      sourceProgram,
      graph,
      revision,
      [
        {
          kind: 'replace_target',
          editId: 'edit:final-check' as never,
          target: literal,
          replacement: { category: 'expression', source: Array.from(encoder.encode('missingName')) },
          preconditions: [],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
      () => ({ ok: false, diagnostics: [{ message: 'unknown name', start: 14, end: 25 }] }),
    );
    expect(result).toMatchObject({ status: 'rejected', reason: 'transformed_source_rejected' });
    expect('source' in result).toBe(false);
  });

  it('fails stale revisions, preconditions, categories, targets, conflicts, and limits without source', () => {
    const stale = applyPrimitiveSemanticEdits(
      sourceProgram,
      graph,
      `semantic-revision:${'9'.repeat(64)}` as SemanticRevisionId,
      [],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(stale).toMatchObject({ status: 'rejected', reason: 'stale_revision' });
    expect('source' in stale).toBe(false);

    expect(
      apply({
        kind: 'replace_target',
        editId: 'edit:category' as never,
        target: literal,
        replacement: { category: 'statement', source: [] },
        preconditions: [],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'fragment_rejected' });
    expect(
      apply({
        kind: 'rename_symbol',
        editId: 'edit:precondition' as never,
        target: firstBinding,
        newName: 'renamed',
        preconditions: [{ kind: 'old_name', value: 'wrong' }],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'precondition_failed' });
    expect(
      apply({
        kind: 'delete_target',
        editId: 'edit:missing' as never,
        target: id('f'),
        commentPolicy: 'preserve_owned_comments',
        preconditions: [],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'target_not_found' });

    const conflict = applyPrimitiveSemanticEdits(
      sourceProgram,
      graph,
      revision,
      [
        {
          kind: 'replace_target',
          editId: 'edit:first' as never,
          target: first,
          replacement: { category: 'statement', source: Array.from(encoder.encode('const replacement = 0;')) },
          preconditions: [],
        },
        {
          kind: 'delete_target',
          editId: 'edit:second' as never,
          target: literal,
          commentPolicy: 'preserve_owned_comments',
          preconditions: [],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(conflict).toMatchObject({ status: 'rejected', reason: 'conflicting_edits' });

    const limited = applyPrimitiveSemanticEdits(
      sourceProgram,
      graph,
      revision,
      [
        {
          kind: 'delete_target',
          editId: 'edit:limit' as never,
          target: first,
          commentPolicy: 'preserve_owned_comments',
          preconditions: [],
        },
      ],
      { ...STANDARD_SEMANTIC_EDIT_LIMITS, transformedRegions: 0 },
    );
    expect(limited).toMatchObject({ status: 'rejected', reason: 'edit_limit_exceeded' });
  });

  it('publishes primitive coverage for every editable node and structural anchor', () => {
    const coverage = primitiveEditCoverage(graph);
    expect(coverage.uncoveredNodes).toEqual([]);
    expect(coverage.uncoveredAnchors).toEqual([]);
    expect(coverage.operations).toEqual([
      'rename_symbol',
      'replace_target',
      'insert_at_anchor',
      'delete_target',
      'move_target',
      'reorder_children',
    ]);
  });
});
