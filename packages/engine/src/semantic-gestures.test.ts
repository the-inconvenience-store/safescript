import { describe, expect, it } from 'bun:test';

import {
  LANGUAGE_PROFILE,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  hash,
  ids,
  type SemanticEdit,
  type SemanticGraph,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SemanticRevisionId,
  type SourceProgram,
} from '@safescript/contracts';

import { applySemanticEditKernel, normalizeSemanticEdits } from './semantic-gestures.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleId = ids.module('module:gestures.test');
const revision = `semantic-revision:${'1'.repeat(64)}` as SemanticRevisionId;
const nodeId = (index: number) => `semantic-node:${index.toString(16).repeat(64)}` as SemanticNodeId;
const editId = (name: string) => `edit:${name}` as never;
type ExpressionGestureEdit = Extract<
  SemanticEdit,
  {
    kind:
      | 'set_literal_value'
      | 'change_operator'
      | 'change_member_name'
      | 'toggle_optional_access'
      | 'change_call_callee'
      | 'change_object_field_name'
      | 'change_result_variant';
  }
>;
type ExpressionGestureInput<T> = T extends SemanticEdit ? Omit<T, 'editId' | 'target' | 'preconditions'> : never;
const fragment = (category: 'expression' | 'statement' | 'binding_pattern', text: string) => ({
  category,
  source: Array.from(encoder.encode(text)),
});

function fixture(
  text: string,
  definitions: readonly Readonly<{
    id: SemanticNodeId;
    kind: SemanticGraphNode['kind'];
    semanticKind: SemanticGraphNode['semanticKind'];
    selected: string;
    occurrence?: number;
    facts?: Partial<SemanticGraphNode>;
  }>[],
  edges: SemanticGraph['edges'] = [],
  anchors: SemanticGraph['anchors'] = [],
): Readonly<{ source: SourceProgram; graph: SemanticGraph }> {
  const source: SourceProgram = { module: moduleId, source: Array.from(encoder.encode(text)) };
  const location = (selected: string, occurrence = 0) => {
    let offset = -1;
    for (let index = 0; index <= occurrence; index++) offset = text.indexOf(selected, offset + 1);
    const start = encoder.encode(text.slice(0, offset)).length;
    return { module: moduleId, start, end: start + encoder.encode(selected).length };
  };
  const whole = location(text);
  const root = nodeId(0);
  const nodes: SemanticGraphNode[] = [
    { id: root, kind: 'module', semanticKind: 'module', source: whole, editable: whole },
    ...definitions.map((definition) => ({
      id: definition.id,
      kind: definition.kind,
      semanticKind: definition.semanticKind,
      source: location(definition.selected, definition.occurrence),
      editable: location(definition.selected, definition.occurrence),
      ...definition.facts,
    })),
  ];
  return {
    source,
    graph: {
      schema: SEMANTIC_GRAPH_SCHEMA,
      semanticRevision: revision,
      sourceHash: hash('source', encoder.encode(text)) as never,
      programHash: hash('program', encoder.encode(text)) as never,
      compiler: { build: 'test' },
      language: LANGUAGE_PROFILE,
      contract: { id: ids.contract('contract:gestures.test'), digest: hash('contract', Uint8Array.of(1)) },
      slotId: ids.slot('slot:gestures.test'),
      moduleId,
      root,
      nodes,
      edges,
      anchors,
      operations: [],
      resources: {
        declarations: 0,
        expressions: 0,
        controlPoints: 0,
        actionSites: 0,
        potentialEffectCost: 0,
        declarationNodes: [],
        expressionNodes: [],
        controlNodes: [],
        actionNodes: [],
      },
    },
  };
}

function appliedText(selected: ReturnType<typeof fixture>, edit: SemanticEdit): string {
  const result = applySemanticEditKernel(
    selected.source,
    selected.graph,
    revision,
    [edit],
    STANDARD_SEMANTIC_EDIT_LIMITS,
  );
  if (result.status !== 'accepted') throw new Error(result.reason);
  expect(result.outcomes).toHaveLength(1);
  return decoder.decode(Uint8Array.from(result.source.source));
}

function expectOperationalGesture(selected: ReturnType<typeof fixture>, edit: SemanticEdit): void {
  const accepted = applySemanticEditKernel(
    selected.source,
    selected.graph,
    revision,
    [edit],
    STANDARD_SEMANTIC_EDIT_LIMITS,
  );
  expect(
    accepted.status,
    `${edit.kind} should apply${accepted.status === 'rejected' ? `: ${accepted.reason} ${accepted.editDiagnostics[0]?.message}` : ''}`,
  ).toBe('accepted');
  const rejected = applySemanticEditKernel(
    selected.source,
    selected.graph,
    revision,
    [{ ...edit, preconditions: [{ kind: 'target_kind', value: 'module' }] } as SemanticEdit],
    STANDARD_SEMANTIC_EDIT_LIMITS,
  );
  expect(rejected, `${edit.kind} should reject a stale capability`).toMatchObject({
    status: 'rejected',
    reason: 'precondition_failed',
    editIds: [edit.editId],
  });
}

describe('semantic expression gestures', () => {
  const cases: readonly Readonly<{
    source: string;
    semanticKind: SemanticGraphNode['semanticKind'];
    facts?: Partial<SemanticGraphNode>;
    edit: ExpressionGestureInput<ExpressionGestureEdit>;
    expected: string;
  }>[] = [
    {
      source: '1',
      semanticKind: 'literal',
      facts: { constant: 1 },
      edit: { kind: 'set_literal_value', value: 2 },
      expected: '2',
    },
    {
      source: 'left + right',
      semanticKind: 'binary',
      facts: { operator: '+' },
      edit: { kind: 'change_operator', operator: '-' },
      expected: 'left - right',
    },
    {
      source: 'value.old',
      semanticKind: 'member',
      edit: { kind: 'change_member_name', name: 'next' },
      expected: 'value.next',
    },
    {
      source: 'value.old',
      semanticKind: 'member',
      edit: { kind: 'toggle_optional_access', optional: true },
      expected: 'value?.old',
    },
    {
      source: 'old(value)',
      semanticKind: 'call',
      edit: { kind: 'change_call_callee', callee: fragment('expression', 'next') },
      expected: 'next(value)',
    },
    {
      source: 'old: value',
      semanticKind: 'object-member',
      edit: { kind: 'change_object_field_name', name: 'next' },
      expected: 'next: value',
    },
    {
      source: 'Ok(value)',
      semanticKind: 'result',
      edit: { kind: 'change_result_variant', variant: 'error' },
      expected: 'Err(value)',
    },
  ];

  for (const selected of cases) {
    it(`applies ${selected.edit.kind} while preserving child expressions`, () => {
      const target = nodeId(1);
      const input = fixture(selected.source, [
        {
          id: target,
          kind: selected.semanticKind === 'literal' ? 'constant' : 'expression',
          semanticKind: selected.semanticKind,
          selected: selected.source,
          ...(selected.facts ? { facts: selected.facts } : {}),
        },
      ]);
      expect(
        appliedText(input, {
          ...selected.edit,
          editId: editId(selected.edit.kind),
          target,
          preconditions: [],
        } as unknown as SemanticEdit),
      ).toBe(selected.expected);
      expectOperationalGesture(input, {
        ...selected.edit,
        editId: editId(selected.edit.kind),
        target,
        preconditions: [],
      } as unknown as SemanticEdit);
    });
  }

  it('rejects stale materialized gesture preconditions before normalization', () => {
    const target = nodeId(1);
    const selected = fixture('1', [
      { id: target, kind: 'constant', semanticKind: 'literal', selected: '1', facts: { constant: 1 } },
    ]);
    const result = applySemanticEditKernel(
      selected.source,
      selected.graph,
      revision,
      [
        {
          kind: 'set_literal_value',
          editId: editId('stale-literal'),
          target,
          value: 2,
          preconditions: [{ kind: 'old_literal', value: 0 }],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'precondition_failed',
      editIds: [editId('stale-literal')],
      targets: [target],
    });
  });

  it('returns a closed target-shape rejection when a gesture cannot normalize', () => {
    const target = nodeId(1);
    const selected = fixture('1', [
      { id: target, kind: 'constant', semanticKind: 'literal', selected: '1', facts: { constant: 1 } },
    ]);
    const result = applySemanticEditKernel(
      selected.source,
      selected.graph,
      revision,
      [
        {
          kind: 'change_member_name',
          editId: editId('wrong-shape'),
          target,
          name: 'next',
          preconditions: [],
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'target_kind_mismatch',
      editIds: [editId('wrong-shape')],
      targets: [target],
    });
  });
});

describe('control, binding, and action gesture normalization', () => {
  it('normalizes all six control gestures with explicit ranges, branches, and retained containers', () => {
    const text = 'first();\nsecond();\nif (ready) {\n  work();\n} else {\n  fallback();\n}\n';
    const container = nodeId(1);
    const first = nodeId(2);
    const second = nodeId(3);
    const control = nodeId(4);
    const retained = nodeId(5);
    const work = nodeId(6);
    const falseBranch = nodeId(7);
    const selected = fixture(
      text,
      [
        { id: container, kind: 'container', semanticKind: 'statement-container', selected: text },
        { id: first, kind: 'statement', semanticKind: 'expression', selected: 'first();' },
        { id: second, kind: 'statement', semanticKind: 'expression', selected: 'second();' },
        {
          id: control,
          kind: 'statement',
          semanticKind: 'if',
          selected: 'if (ready) {\n  work();\n} else {\n  fallback();\n}',
        },
        { id: retained, kind: 'container', semanticKind: 'statement-container', selected: '{\n  work();\n}' },
        { id: work, kind: 'statement', semanticKind: 'expression', selected: 'work();' },
        {
          id: falseBranch,
          kind: 'branch',
          semanticKind: 'branch-case',
          selected: '{\n  fallback();\n}',
          facts: { label: 'false' },
        },
      ],
      [
        { kind: 'contains', from: container, to: first, index: 0 },
        { kind: 'contains', from: container, to: second, index: 1 },
        { kind: 'contains', from: container, to: control, index: 2 },
        { kind: 'contains', from: control, to: retained },
        { kind: 'contains', from: control, to: falseBranch, index: 1 },
        { kind: 'contains', from: retained, to: work, index: 0 },
      ],
      [
        { container, index: 0, before: first },
        { container, index: 1, before: second, after: first },
        { container, index: 2, before: control, after: second },
        { container, index: 3, after: control },
      ],
    );
    const range = { container, first, last: second } as const;
    const destination = selected.graph.anchors[2] as NonNullable<(typeof selected.graph.anchors)[number]>;
    const edits: SemanticEdit[] = [
      {
        kind: 'wrap_statement_range',
        editId: editId('wrap'),
        range,
        control: { kind: 'if', condition: fragment('expression', 'ready'), branch: 'true' },
        preconditions: [],
      },
      {
        kind: 'move_statement_range',
        editId: editId('move-range'),
        range: { container, first, last: first },
        destination,
        preconditions: [],
      },
      {
        kind: 'unwrap_control',
        editId: editId('unwrap'),
        target: control,
        retainedContainer: retained,
        preconditions: [],
      },
      {
        kind: 'add_branch',
        editId: editId('branch'),
        target: control,
        branch: { kind: 'else', body: fragment('statement', 'fallback();') },
        preconditions: [],
      },
      {
        kind: 'remove_branch',
        editId: editId('remove-branch'),
        target: falseBranch,
        commentPolicy: 'preserve_owned_comments',
        preconditions: [],
      },
      {
        kind: 'convert_control',
        editId: editId('convert'),
        target: control,
        control: { kind: 'while', condition: fragment('expression', 'ready') },
        retainedContainers: [{ from: retained, role: 'body' }],
        preconditions: [],
      },
    ];
    for (const edit of edits.filter((edit) => edit.kind !== 'add_branch')) expectOperationalGesture(selected, edit);
    const addControl = nodeId(20);
    const addSelected = fixture('if (ready) {\n  work();\n}\n', [
      {
        id: addControl,
        kind: 'statement',
        semanticKind: 'if',
        selected: 'if (ready) {\n  work();\n}',
      },
    ]);
    expectOperationalGesture(addSelected, { ...edits[3], target: addControl } as SemanticEdit);
  });

  it('moves a multi-statement range across containers atomically', () => {
    const text = 'a();\nb();\nif (ready) {\n  c();\n}\n';
    const sourceContainer = nodeId(30);
    const first = nodeId(31);
    const last = nodeId(32);
    const destinationContainer = nodeId(33);
    const destinationStatement = nodeId(34);
    const selected = fixture(
      text,
      [
        { id: sourceContainer, kind: 'container', semanticKind: 'statement-container', selected: text },
        { id: first, kind: 'statement', semanticKind: 'expression', selected: 'a();' },
        { id: last, kind: 'statement', semanticKind: 'expression', selected: 'b();' },
        {
          id: destinationContainer,
          kind: 'container',
          semanticKind: 'statement-container',
          selected: '{\n  c();\n}',
        },
        { id: destinationStatement, kind: 'statement', semanticKind: 'expression', selected: 'c();' },
      ],
      [
        { kind: 'contains', from: sourceContainer, to: first, index: 0 },
        { kind: 'contains', from: sourceContainer, to: last, index: 1 },
        { kind: 'contains', from: destinationContainer, to: destinationStatement, index: 0 },
      ],
      [{ container: destinationContainer, index: 0, before: destinationStatement }],
    );
    expectOperationalGesture(selected, {
      kind: 'move_statement_range',
      editId: editId('cross-container-range'),
      range: { container: sourceContainer, first, last },
      destination: selected.graph.anchors[0] as NonNullable<(typeof selected.graph.anchors)[number]>,
      preconditions: [],
    });
  });

  it('normalizes all six binding/extraction gestures without inventing undeclared mappings', () => {
    const text = 'const item = source();\nuse(item);\nfunction helper(value) { return value + 1; }\nhelper(item);\n';
    const container = nodeId(1);
    const declaration = nodeId(2);
    const binding = nodeId(3);
    const initializer = nodeId(4);
    const use = nodeId(5);
    const reference = nodeId(6);
    const fn = nodeId(7);
    const parameter = nodeId(8);
    const call = nodeId(9);
    const argument = nodeId(10);
    const pattern = nodeId(11);
    const moduleContainer = nodeId(12);
    const selected = fixture(
      text,
      [
        { id: container, kind: 'container', semanticKind: 'statement-container', selected: text },
        { id: moduleContainer, kind: 'container', semanticKind: 'module-container', selected: text },
        { id: declaration, kind: 'statement', semanticKind: 'variable', selected: 'const item = source();' },
        {
          id: binding,
          kind: 'binding',
          semanticKind: 'binding-pattern',
          selected: 'item = source()',
          facts: { label: 'item' },
        },
        { id: pattern, kind: 'binding', semanticKind: 'symbol', selected: 'item', facts: { label: 'item' } },
        { id: initializer, kind: 'expression', semanticKind: 'call', selected: 'source()' },
        { id: use, kind: 'statement', semanticKind: 'expression', selected: 'use(item);' },
        {
          id: reference,
          kind: 'expression',
          semanticKind: 'name',
          selected: 'item',
          occurrence: 1,
          facts: { label: 'item' },
        },
        {
          id: fn,
          kind: 'declaration',
          semanticKind: 'function',
          selected: 'function helper(value) { return value + 1; }',
          facts: { label: 'helper' },
        },
        { id: parameter, kind: 'binding', semanticKind: 'parameter', selected: 'value', facts: { label: 'value' } },
        { id: call, kind: 'expression', semanticKind: 'call', selected: 'helper(item)' },
        {
          id: argument,
          kind: 'expression',
          semanticKind: 'name',
          selected: 'item',
          occurrence: 2,
          facts: { label: 'item' },
        },
      ],
      [
        { kind: 'contains', from: container, to: declaration, index: 0 },
        { kind: 'contains', from: declaration, to: binding },
        { kind: 'contains', from: binding, to: pattern, role: 'binding' },
        { kind: 'contains', from: binding, to: initializer },
        { kind: 'contains', from: container, to: use, index: 1 },
        { kind: 'contains', from: use, to: reference },
        { kind: 'contains', from: nodeId(0), to: moduleContainer },
        { kind: 'contains', from: moduleContainer, to: fn, index: 0 },
        { kind: 'contains', from: fn, to: parameter },
        { kind: 'contains', from: container, to: call, index: 2 },
        { kind: 'contains', from: call, to: argument },
      ],
      [
        { container, index: 0, before: declaration },
        { container, index: 1, before: use, after: declaration },
        { container, index: 2, before: call, after: use },
        { container, index: 3, after: call },
        { container: moduleContainer, index: 0, before: fn },
      ],
    );
    const destination = selected.graph.anchors[0] as NonNullable<(typeof selected.graph.anchors)[number]>;
    const declarationAnchor = selected.graph.anchors[4] as NonNullable<(typeof selected.graph.anchors)[number]>;
    const edits: SemanticEdit[] = [
      {
        kind: 'extract_local',
        editId: editId('extract-local'),
        target: initializer,
        name: 'created',
        declaration: destination,
        replaceTargets: [initializer],
        preconditions: [],
      },
      {
        kind: 'inline_local',
        editId: editId('inline-local'),
        binding,
        references: [reference],
        removeDeclaration: true,
        commentPolicy: 'preserve_owned_comments',
        preconditions: [],
      },
      {
        kind: 'extract_function',
        editId: editId('extract-function'),
        range: { container, first: use, last: use },
        name: 'extracted',
        declaration: declarationAnchor,
        parameters: [],
        outputs: [],
        preconditions: [],
      },
      {
        kind: 'inline_function_call',
        editId: editId('inline-function'),
        call,
        function: fn,
        parameterArguments: [{ parameter, argument }],
        removeDeclaration: false,
        commentPolicy: 'preserve_owned_comments',
        preconditions: [],
      },
      {
        kind: 'change_binding_pattern',
        editId: editId('pattern'),
        target: binding,
        pattern: fragment('binding_pattern', 'next'),
        preconditions: [],
      },
      {
        kind: 'change_binding_mutability',
        editId: editId('mutability'),
        target: binding,
        mutability: 'let',
        preconditions: [],
      },
    ];
    for (const edit of edits) expectOperationalGesture(selected, edit);
    expect(appliedText(selected, edits[4] as SemanticEdit)).toContain('const next = source();');
  });

  it('extracts a function with explicit capture renaming, type preservation, and mapped outputs', () => {
    const text = 'const input: number = 1;\nconst output = input + 1;\nuse(output);\n';
    const moduleContainer = nodeId(40);
    const statementContainer = nodeId(41);
    const inputStatement = nodeId(42);
    const inputBinding = nodeId(43);
    const inputType = nodeId(44);
    const outputStatement = nodeId(45);
    const outputBinding = nodeId(46);
    const capturedReference = nodeId(47);
    const useStatement = nodeId(48);
    const outputReference = nodeId(49);
    const inputSymbol = ids.symbol(`symbol:${'a'.repeat(64)}`);
    const outputSymbol = ids.symbol(`symbol:${'b'.repeat(64)}`);
    const selected = fixture(
      text,
      [
        { id: moduleContainer, kind: 'container', semanticKind: 'module-container', selected: text },
        { id: statementContainer, kind: 'container', semanticKind: 'statement-container', selected: text },
        {
          id: inputStatement,
          kind: 'statement',
          semanticKind: 'variable',
          selected: 'const input: number = 1;',
        },
        {
          id: inputBinding,
          kind: 'binding',
          semanticKind: 'binding-pattern',
          selected: 'input: number = 1',
          facts: { label: 'input', symbolId: inputSymbol },
        },
        { id: inputType, kind: 'type', semanticKind: 'structured', selected: 'number' },
        {
          id: outputStatement,
          kind: 'statement',
          semanticKind: 'variable',
          selected: 'const output = input + 1;',
        },
        {
          id: outputBinding,
          kind: 'binding',
          semanticKind: 'binding-pattern',
          selected: 'output = input + 1',
          facts: { label: 'output', symbolId: outputSymbol },
        },
        { id: capturedReference, kind: 'expression', semanticKind: 'name', selected: 'input', occurrence: 1 },
        { id: useStatement, kind: 'statement', semanticKind: 'expression', selected: 'use(output);' },
        { id: outputReference, kind: 'expression', semanticKind: 'name', selected: 'output', occurrence: 1 },
      ],
      [
        { kind: 'contains', from: moduleContainer, to: inputStatement, index: 0 },
        { kind: 'contains', from: statementContainer, to: inputStatement, index: 0 },
        { kind: 'contains', from: statementContainer, to: outputStatement, index: 1 },
        { kind: 'contains', from: statementContainer, to: useStatement, index: 2 },
        { kind: 'contains', from: inputStatement, to: inputBinding },
        { kind: 'contains', from: inputBinding, to: inputType },
        { kind: 'contains', from: outputStatement, to: outputBinding },
        { kind: 'contains', from: outputBinding, to: capturedReference },
        { kind: 'contains', from: useStatement, to: outputReference },
        { kind: 'references', from: capturedReference, to: inputBinding },
        { kind: 'references', from: outputReference, to: outputBinding },
      ],
      [{ container: moduleContainer, index: 0, before: inputStatement }],
    );
    const transformed = appliedText(selected, {
      kind: 'extract_function',
      editId: editId('mapped-extract-function'),
      range: { container: statementContainer, first: outputStatement, last: outputStatement },
      name: 'calculate',
      declaration: selected.graph.anchors[0] as NonNullable<(typeof selected.graph.anchors)[number]>,
      parameters: [{ symbol: inputSymbol, name: 'capturedInput' }],
      outputs: [outputSymbol],
      preconditions: [],
    });
    expect(transformed).toContain('function calculate(capturedInput: number)');
    expect(transformed).toContain('const output = capturedInput + 1;');
    expect(transformed).toContain('return output;');
    expect(transformed).toContain('const output = calculate(input);');
  });

  it('normalizes all five host-action gestures including schema paths and result handling', () => {
    const text = 'const result = await ctx.tasks.create({ title: "a", extra: 1 });\n';
    const container = nodeId(1);
    const statement = nodeId(2);
    const binding = nodeId(3);
    const action = nodeId(4);
    const selected = fixture(
      text,
      [
        { id: container, kind: 'container', semanticKind: 'statement-container', selected: text },
        {
          id: statement,
          kind: 'statement',
          semanticKind: 'variable',
          selected: 'const result = await ctx.tasks.create({ title: "a", extra: 1 });',
        },
        { id: binding, kind: 'binding', semanticKind: 'symbol', selected: 'result', facts: { label: 'result' } },
        {
          id: action,
          kind: 'action',
          semanticKind: 'host-action',
          selected: 'ctx.tasks.create({ title: "a", extra: 1 })',
          facts: { operationId: ids.operation('operation:tasks.create') },
        },
      ],
      [
        { kind: 'contains', from: container, to: statement, index: 0 },
        { kind: 'contains', from: statement, to: binding },
        { kind: 'contains', from: statement, to: action },
      ],
      [
        { container, index: 0, before: statement },
        { container, index: 1, after: statement },
      ],
    );
    const edits: SemanticEdit[] = [
      {
        kind: 'change_action_operation',
        editId: editId('action-op'),
        target: action,
        operation: ids.operation('operation:tasks.update'),
        fieldMappings: [{ from: ['title'], to: ['name'] }],
        requiredInputs: [{ path: ['id'], value: fragment('expression', 'taskId') }],
        preconditions: [],
      },
      {
        kind: 'set_action_input_field',
        editId: editId('set-field'),
        target: action,
        path: ['title'],
        value: fragment('expression', '"next"'),
        preconditions: [],
      },
      {
        kind: 'remove_action_input_field',
        editId: editId('remove-field'),
        target: action,
        path: ['extra'],
        preconditions: [],
      },
      {
        kind: 'bind_action_result',
        editId: editId('bind-result'),
        target: action,
        pattern: fragment('binding_pattern', 'updated'),
        preconditions: [],
      },
      {
        kind: 'add_action_result_branch',
        editId: editId('result-branch'),
        target: action,
        variant: 'error',
        body: fragment('statement', 'return Err(result.value);'),
        preconditions: [],
      },
    ];
    const changedOperation = normalizeSemanticEdits(selected.source, selected.graph, [edits[0] as SemanticEdit]);
    expect(changedOperation?.[0]).toMatchObject({
      kind: 'replace_target',
      replacement: {
        category: 'expression',
        source: Array.from(encoder.encode('ctx.tasks.update({ name: "a", id: taskId })')),
      },
    });
    for (const edit of edits) expectOperationalGesture(selected, edit);
  });
});
