import { describe, expect, it } from 'bun:test';

import {
  LANGUAGE_PROFILE,
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  defineSchemaRegistry,
  hash,
  ids,
  type ContractRegistry,
  type SemanticGraph,
  type SemanticNodeId,
  type SemanticRevisionId,
  type SourceProgram,
} from '@safescript/contracts';

import { deriveSemanticEditCapabilities } from './semantic-capabilities.js';

const encoder = new TextEncoder();
const sourceText = '// owned\nconst item = 1;\nreturn Ok(item);\n';
const moduleId = ids.module('module:capabilities.test');
const source: SourceProgram = { module: moduleId, source: Array.from(encoder.encode(sourceText)) };
const nodeId = (digit: string) => `semantic-node:${digit.repeat(64)}` as SemanticNodeId;
const root = nodeId('0');
const container = nodeId('1');
const statement = nodeId('2');
const binding = nodeId('3');
const literal = nodeId('4');
const returned = nodeId('5');
const result = nodeId('6');
const revision = `semantic-revision:${'7'.repeat(64)}` as SemanticRevisionId;
const digest = hash('contract', Uint8Array.of(1));
const registry: ContractRegistry = {
  id: ids.contract('contract:capabilities.test'),
  digest,
  schemas: defineSchemaRegistry([]),
  operations: [],
  slots: [],
  definitions: [],
};
const slot = {
  id: ids.slot('slot:capabilities.test'),
  input: ids.type('type:capabilities.input'),
  output: ids.type('type:capabilities.output'),
  operations: [],
  compileLimits: {} as never,
  executionLimits: {} as never,
  fingerprint: digest,
};
const location = (selected: string, occurrence = 0) => {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = sourceText.indexOf(selected, offset + 1);
  const start = encoder.encode(sourceText.slice(0, offset)).length;
  return { module: moduleId, start, end: start + encoder.encode(selected).length };
};
const graph: SemanticGraph = {
  schema: SEMANTIC_GRAPH_SCHEMA,
  semanticRevision: revision,
  sourceHash: hash('source', encoder.encode(sourceText)) as never,
  programHash: hash('program', encoder.encode(sourceText)) as never,
  compiler: { build: 'test' },
  language: LANGUAGE_PROFILE,
  contract: { id: registry.id, digest },
  slotId: slot.id,
  moduleId,
  root,
  nodes: [
    { id: root, kind: 'module', semanticKind: 'module', source: location(sourceText), editable: location(sourceText) },
    {
      id: container,
      kind: 'container',
      semanticKind: 'statement-container',
      source: location(sourceText),
      editable: location(sourceText),
    },
    {
      id: statement,
      kind: 'statement',
      semanticKind: 'variable',
      source: location('const item = 1;'),
      editable: location('const item = 1;'),
    },
    {
      id: binding,
      kind: 'binding',
      semanticKind: 'symbol',
      source: location('item', 0),
      editable: location('item', 0),
      label: 'item',
      symbolId: ids.symbol(`symbol:${'8'.repeat(64)}`),
    },
    {
      id: literal,
      kind: 'constant',
      semanticKind: 'literal',
      source: location('1'),
      editable: location('1'),
      constant: 1,
    },
    {
      id: returned,
      kind: 'statement',
      semanticKind: 'return',
      source: location('return Ok(item);'),
      editable: location('return Ok(item);'),
    },
    {
      id: result,
      kind: 'expression',
      semanticKind: 'result',
      source: location('Ok(item)'),
      editable: location('Ok(item)'),
      label: 'ok',
    },
  ],
  edges: [
    { kind: 'contains', from: root, to: container },
    { kind: 'contains', from: container, to: statement, index: 0 },
    { kind: 'contains', from: container, to: returned, index: 1 },
    { kind: 'contains', from: statement, to: binding, role: 'binding' },
    { kind: 'contains', from: statement, to: literal, role: 'initializer' },
    { kind: 'contains', from: returned, to: result, role: 'value' },
    { kind: 'binds', from: statement, to: binding, role: 'binding' },
  ],
  anchors: [
    { container, index: 0, before: statement },
    { container, index: 1, before: returned, after: statement },
    { container, index: 2, after: returned },
  ],
  operations: [],
  resources: {
    declarations: 1,
    expressions: 2,
    controlPoints: 2,
    actionSites: 0,
    potentialEffectCost: 0,
    declarationNodes: [binding],
    expressionNodes: [literal, result],
    controlNodes: [statement, returned],
    actionNodes: [],
  },
};

describe('semantic edit capability projection', () => {
  it('materializes sufficient primitive and gesture inputs for a generic client', () => {
    const projected = deriveSemanticEditCapabilities(
      source,
      graph,
      registry,
      slot,
      'all',
      STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
    );
    expect('code' in projected).toBe(false);
    if ('code' in projected) return;
    expect(projected.manifest).toMatchObject({
      schema: SEMANTIC_EDIT_SCHEMA,
      graphSchema: SEMANTIC_GRAPH_SCHEMA,
      semanticRevision: revision,
    });
    const bindingTarget = projected.manifest.targets.find((target) => target.target === binding);
    expect(bindingTarget?.capabilities.map((capability) => capability.kind)).toContain('rename_symbol');
    expect(bindingTarget?.capabilities.find((capability) => capability.kind === 'rename_symbol')).toMatchObject({
      preconditions: expect.arrayContaining([{ kind: 'old_name', value: 'item' }]),
      suggestedNames: expect.any(Array),
    });
    expect(bindingTarget?.capabilities.map((capability) => capability.kind)).not.toContain('inline_local');
    const literalTarget = projected.manifest.targets.find((target) => target.target === literal);
    expect(literalTarget?.capabilities.map((capability) => capability.kind)).toEqual(
      expect.arrayContaining(['replace_target', 'set_literal_value']),
    );
    expect(literalTarget?.capabilities.map((capability) => capability.kind)).not.toContain('move_target');
    const containerTarget = projected.manifest.targets.find((target) => target.target === container);
    expect(containerTarget?.capabilities.find((capability) => capability.kind === 'insert_at_anchor')).toMatchObject({
      fragmentCategories: ['statement', 'statement_list'],
      anchors: graph.anchors,
    });
    expect(projected.bytes.length).toBe(projected.manifest.usage.bytes);
  });

  it('supports target-filtered scope and fails each independent limit atomically', () => {
    const scoped = deriveSemanticEditCapabilities(
      source,
      graph,
      registry,
      slot,
      { targets: [literal] },
      STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
    );
    if ('code' in scoped) throw new Error(scoped.code);
    expect(scoped.manifest.targets.map((target) => target.target)).toEqual([literal]);
    for (const [limit, maximum] of [
      ['targets', 0],
      ['capabilities', 0],
      ['bytes', 1],
    ] as const) {
      const rejected = deriveSemanticEditCapabilities(source, graph, registry, slot, 'all', {
        ...STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
        [limit]: maximum,
      });
      expect(rejected).toMatchObject({ code: 'capability_limit_exceeded', limit, maximum });
      expect('manifest' in rejected).toBe(false);
    }
  });
});
