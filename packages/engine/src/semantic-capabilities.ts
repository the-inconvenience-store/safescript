/** Deterministic, independently bounded semantic-edit capability projection. @internal */
import {
  SEMANTIC_EDIT_SCHEMA,
  hash,
  type ContractRegistry,
  type OperationId,
  type Schema,
  type SemanticEditCapability,
  type SemanticEditCapabilityError,
  type SemanticEditCapabilityLimits,
  type SemanticEditCapabilityManifest,
  type SemanticEditCapabilityScope,
  type SemanticEditExpectedSchema,
  type SemanticEditKind,
  type SemanticEditPrecondition,
  type SemanticEditTargetCapabilities,
  type SemanticGraph,
  type SemanticGraphAnchor,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SemanticSchemaPath,
  type SlotDefinition,
  type SourceFragmentCategory,
  type SourceProgram,
  type SymbolId,
} from '@safescript/contracts';

import { insertionCategories, replacementCategories } from './semantic-primitives.js';
import { EditableSourceDocument } from './source-transform.js';

const encoder = new TextEncoder();

export interface DerivedSemanticEditCapabilities {
  readonly manifest: SemanticEditCapabilityManifest;
  readonly bytes: readonly number[];
}

interface CapabilityIndex {
  readonly nodes: ReadonlyMap<SemanticNodeId, SemanticGraphNode>;
  readonly parents: ReadonlyMap<SemanticNodeId, SemanticNodeId>;
  readonly children: ReadonlyMap<SemanticNodeId, readonly SemanticNodeId[]>;
  readonly anchors: ReadonlyMap<SemanticNodeId, readonly SemanticGraphAnchor[]>;
}

function indexGraph(graph: SemanticGraph): CapabilityIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<SemanticNodeId, SemanticNodeId>();
  const mutableChildren = new Map<SemanticNodeId, Array<Readonly<{ id: SemanticNodeId; index: number }>>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') continue;
    parents.set(edge.to, edge.from);
    const selected = mutableChildren.get(edge.from) ?? [];
    selected.push({ id: edge.to, index: edge.index ?? selected.length });
    mutableChildren.set(edge.from, selected);
  }
  const children = new Map<SemanticNodeId, readonly SemanticNodeId[]>();
  for (const [parent, selected] of mutableChildren)
    children.set(
      parent,
      Object.freeze(selected.sort((left, right) => left.index - right.index).map((item) => item.id)),
    );
  const mutableAnchors = new Map<SemanticNodeId, SemanticGraphAnchor[]>();
  for (const anchor of graph.anchors) {
    const selected = mutableAnchors.get(anchor.container) ?? [];
    selected.push(anchor);
    mutableAnchors.set(anchor.container, selected);
  }
  const anchors = new Map<SemanticNodeId, readonly SemanticGraphAnchor[]>();
  for (const [container, selected] of mutableAnchors) anchors.set(container, Object.freeze(selected));
  return { nodes, parents, children, anchors };
}

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `{"$int64":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function canonicalBytes(value: unknown): readonly number[] {
  return Object.freeze(Array.from(encoder.encode(canonical(value))));
}

function ownedComments(document: EditableSourceDocument, node: SemanticGraphNode): boolean {
  if (!node.editable || node.editable.end <= node.editable.start) return false;
  try {
    const owned = document.ownedRange({ start: node.editable.start, end: node.editable.end });
    return owned.start !== node.editable.start || owned.end !== node.editable.end;
  } catch {
    return false;
  }
}

function descendantBindings(index: CapabilityIndex, nodeId: SemanticNodeId): readonly SymbolId[] {
  const output = new Set<SymbolId>();
  const visit = (selected: SemanticNodeId): void => {
    const node = index.nodes.get(selected);
    if (node?.symbolId) output.add(node.symbolId);
    for (const child of index.children.get(selected) ?? []) visit(child);
  };
  visit(nodeId);
  return Object.freeze([...output].sort());
}

function containerFor(index: CapabilityIndex, nodeId: SemanticNodeId): SemanticNodeId | undefined {
  let parent = index.parents.get(nodeId);
  while (parent) {
    if (index.nodes.get(parent)?.kind === 'container') return parent;
    parent = index.parents.get(parent);
  }
  return undefined;
}

function ancestorNode(
  index: CapabilityIndex,
  nodeId: SemanticNodeId,
  predicate: (node: SemanticGraphNode) => boolean,
): SemanticGraphNode | undefined {
  let selected = index.parents.get(nodeId);
  while (selected) {
    const node = index.nodes.get(selected);
    if (node && predicate(node)) return node;
    selected = index.parents.get(selected);
  }
  return undefined;
}

function schemaPaths(
  schema: Schema,
  registry: ContractRegistry,
  seen = new Set<string>(),
): readonly SemanticSchemaPath[] {
  if (schema.kind === 'ref') {
    if (seen.has(schema.type)) return Object.freeze([]);
    const selected = registry.schemas.types.find((definition) => definition.id === schema.type)?.schema;
    return selected ? schemaPaths(selected, registry, new Set([...seen, schema.type])) : Object.freeze([]);
  }
  if (schema.kind === 'record')
    return Object.freeze(
      schema.fields.flatMap((field) => [
        Object.freeze([field.name]),
        ...schemaPaths(field.schema, registry, seen).map((path) => Object.freeze([field.name, ...path])),
      ]),
    );
  if (schema.kind === 'tuple')
    return Object.freeze(
      schema.items.flatMap((item, index) => [
        Object.freeze([index]),
        ...schemaPaths(item, registry, seen).map((path) => Object.freeze([index, ...path])),
      ]),
    );
  if (schema.kind === 'list')
    return Object.freeze([
      Object.freeze([0]),
      ...schemaPaths(schema.item, registry, seen).map((path) => Object.freeze([0, ...path])),
    ]);
  return Object.freeze([]);
}

function operationSchemas(
  node: SemanticGraphNode,
  registry: ContractRegistry,
  operations: readonly OperationId[],
): readonly SemanticEditExpectedSchema[] {
  const output: SemanticEditExpectedSchema[] = [];
  if (node.type) output.push({ role: 'target', schema: node.type });
  for (const operationId of operations) {
    const operation = registry.operations.find((candidate) => candidate.id === operationId);
    if (!operation) continue;
    output.push(
      { role: 'operation_input', operation: operation.id, schema: { kind: 'ref', type: operation.input } },
      { role: 'operation_output', operation: operation.id, schema: { kind: 'ref', type: operation.output } },
      { role: 'operation_error', operation: operation.id, schema: { kind: 'ref', type: operation.error } },
    );
  }
  return Object.freeze(output);
}

const binaryOperators = Object.freeze(['===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '&&', '||', '??']);
const unaryOperators = Object.freeze(['!', '+', '-', '++', '--']);
const controlKinds: SemanticEditCapability['controlKinds'] = Object.freeze([
  'if',
  'for_of',
  'for_in',
  'while',
  'do',
  'for',
  'switch',
]);
const branchKinds: SemanticEditCapability['branchKinds'] = Object.freeze(['true', 'false', 'else', 'switch_case']);
const resultVariants: SemanticEditCapability['resultVariants'] = Object.freeze(['ok', 'error']);
const mutabilities: SemanticEditCapability['mutabilities'] = Object.freeze(['const', 'let']);

function operationKinds(
  node: SemanticGraphNode,
  index: CapabilityIndex,
  graph: SemanticGraph,
  registry: ContractRegistry,
  slot: SlotDefinition,
): readonly SemanticEditKind[] {
  const kinds: SemanticEditKind[] = [];
  const replacement = replacementCategories(node);
  const insertion = insertionCategories(node);
  const binds = graph.edges.some((edge) => edge.kind === 'binds' && edge.from === node.id);
  if (node.semanticKind === 'symbol' || binds) kinds.push('rename_symbol');
  if (replacement.length > 0) kinds.push('replace_target');
  if (insertion.length > 0 && (index.anchors.get(node.id)?.length ?? 0) > 0) kinds.push('insert_at_anchor');
  if (node.editable && node.id !== graph.root) kinds.push('delete_target');
  const movable = graph.anchors.some((anchor) => {
    const accepted = insertionCategories(index.nodes.get(anchor.container));
    return replacement.some((category) => accepted.includes(category));
  });
  if (node.editable && node.id !== graph.root && movable) kinds.push('move_target');
  if (node.kind === 'container' && (index.children.get(node.id)?.length ?? 0) > 0) kinds.push('reorder_children');
  if (node.kind === 'container' && node.semanticKind === 'statement-container') {
    kinds.push('wrap_statement_range');
    if (capabilityAnchors('move_statement_range', node, index, graph).length > 0) kinds.push('move_statement_range');
    if (capabilityAnchors('extract_function', node, index, graph).length > 0) kinds.push('extract_function');
  }
  if (['if', 'for-of', 'for-in', 'loop', 'switch'].includes(node.semanticKind))
    kinds.push('unwrap_control', 'convert_control');
  const hasFalseBranch = (index.children.get(node.id) ?? []).some(
    (child) => index.nodes.get(child)?.semanticKind === 'branch-case' && index.nodes.get(child)?.label === 'false',
  );
  if ((node.semanticKind === 'if' && !hasFalseBranch) || node.semanticKind === 'switch') kinds.push('add_branch');
  if ((node.semanticKind === 'branch-case' && node.label === 'false') || node.semanticKind === 'switch-case')
    kinds.push('remove_branch');
  if (
    (node.kind === 'expression' || node.kind === 'constant' || node.kind === 'action') &&
    capabilityAnchors('extract_local', node, index, graph).length > 0
  )
    kinds.push('extract_local');
  if (node.kind === 'binding') kinds.push('change_binding_pattern');
  if (
    node.kind === 'binding' &&
    node.semanticKind === 'binding-pattern' &&
    (index.children.get(node.id) ?? []).some((child) => index.nodes.get(child)?.kind === 'expression')
  )
    kinds.push('inline_local');
  const variableStatement = ancestorNode(
    index,
    node.id,
    (candidate) => candidate.kind === 'statement' && candidate.semanticKind === 'variable',
  );
  if (node.kind === 'binding' && variableStatement) kinds.push('change_binding_mutability');
  if (node.semanticKind === 'call') kinds.push('inline_function_call', 'change_call_callee');
  if (node.kind === 'action') {
    const operation = node.operationId
      ? registry.operations.find((candidate) => candidate.id === node.operationId)
      : undefined;
    const input = operation
      ? registry.schemas.types.find((definition) => definition.id === operation.input)?.schema
      : undefined;
    const statement = ancestorNode(index, node.id, (candidate) => candidate.kind === 'statement');
    const statementBindings = statement ? descendantBindings(index, statement.id) : [];
    if (slot.operations.length > 0) kinds.push('change_action_operation');
    if (input && schemaPaths(input, registry).length > 0) kinds.push('set_action_input_field');
    if (statement) kinds.push('bind_action_result');
    if (statement && statementBindings.length > 0 && graph.anchors.some((anchor) => anchor.after === statement.id))
      kinds.push('add_action_result_branch');
  }
  if (node.semanticKind === 'literal') kinds.push('set_literal_value');
  if (node.operator) kinds.push('change_operator');
  if (node.semanticKind === 'member') kinds.push('change_member_name', 'toggle_optional_access');
  if (node.semanticKind === 'index') kinds.push('toggle_optional_access');
  if (node.semanticKind === 'object-member') kinds.push('change_object_field_name');
  if (node.semanticKind === 'result') kinds.push('change_result_variant');
  return Object.freeze([...new Set(kinds)]);
}

function preconditions(
  node: SemanticGraphNode,
  parent: SemanticNodeId | undefined,
  bindings: readonly SymbolId[],
  hasOwnedComments: boolean,
): readonly SemanticEditPrecondition[] {
  return Object.freeze([
    { kind: 'target_kind', value: node.kind },
    { kind: 'target_semantic_kind', value: node.semanticKind },
    ...(node.label ? ([{ kind: 'old_name', value: node.label }] as const) : []),
    ...(node.constant !== undefined ? ([{ kind: 'old_literal', value: node.constant }] as const) : []),
    ...(node.operator ? ([{ kind: 'old_operator', value: node.operator }] as const) : []),
    ...(node.operationId ? ([{ kind: 'old_operation', value: node.operationId }] as const) : []),
    ...(node.type
      ? ([{ kind: 'expected_type', value: hash('type', encoder.encode(canonical(node.type))) }] as const)
      : []),
    ...(parent ? ([{ kind: 'expected_parent', value: parent }] as const) : []),
    ...(bindings.length > 0 ? ([{ kind: 'expected_bindings', value: bindings }] as const) : []),
    { kind: 'owned_comments', value: hasOwnedComments },
  ]);
}

function capabilityAnchors(
  kind: SemanticEditKind,
  node: SemanticGraphNode,
  index: CapabilityIndex,
  graph: SemanticGraph,
): readonly SemanticGraphAnchor[] {
  if (kind === 'insert_at_anchor') return Object.freeze([...(index.anchors.get(node.id) ?? [])]);
  const categories =
    kind === 'move_target'
      ? replacementCategories(node)
      : kind === 'move_statement_range' || kind === 'extract_local' || kind === 'add_action_result_branch'
        ? (['statement', 'statement_list'] as const)
        : kind === 'extract_function'
          ? (['declaration', 'declaration_list'] as const)
          : [];
  if (categories.length === 0) return Object.freeze([]);
  return Object.freeze(
    graph.anchors.filter((anchor) => {
      const accepted = insertionCategories(index.nodes.get(anchor.container));
      return categories.some((category) => accepted.includes(category));
    }),
  );
}

function names(node: SemanticGraphNode, occupied: ReadonlySet<string>): readonly string[] {
  const stem = node.label && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.label) ? node.label : 'value';
  const output: string[] = [];
  for (const candidate of [`${stem}Value`, `${stem}2`, 'value', 'result'])
    if (!occupied.has(candidate) && !output.includes(candidate)) output.push(candidate);
  return Object.freeze(output);
}

function capability(
  kind: SemanticEditKind,
  node: SemanticGraphNode,
  index: CapabilityIndex,
  graph: SemanticGraph,
  registry: ContractRegistry,
  slot: SlotDefinition,
  occupied: ReadonlySet<string>,
  hasOwnedComments: boolean,
): SemanticEditCapability {
  const bindingSet = descendantBindings(index, node.id);
  const parent = index.parents.get(node.id);
  const targetOperations = node.kind === 'action' ? slot.operations : Object.freeze([]);
  const inputOperation = node.operationId
    ? registry.operations.find((operation) => operation.id === node.operationId)
    : undefined;
  const inputSchema = inputOperation
    ? registry.schemas.types.find((definition) => definition.id === inputOperation.input)?.schema
    : undefined;
  const fragments: readonly SourceFragmentCategory[] =
    kind === 'replace_target'
      ? replacementCategories(node)
      : kind === 'insert_at_anchor'
        ? insertionCategories(node)
        : kind === 'change_binding_pattern' || kind === 'bind_action_result'
          ? ['binding_pattern']
          : kind === 'change_call_callee'
            ? ['expression']
            : kind === 'set_action_input_field'
              ? ['expression']
              : [];
  return Object.freeze({
    kind,
    preconditions: preconditions(node, parent, bindingSet, hasOwnedComments),
    fragmentCategories: Object.freeze([...fragments]),
    anchors: capabilityAnchors(kind, node, index, graph),
    operators: node.semanticKind === 'binary' ? binaryOperators : node.semanticKind === 'unary' ? unaryOperators : [],
    operations: Object.freeze([...targetOperations]),
    expectedSchemas: operationSchemas(node, registry, targetOperations),
    schemaPaths: inputSchema ? schemaPaths(inputSchema, registry) : Object.freeze([]),
    bindings:
      kind === 'extract_function' || kind === 'inline_local' || kind === 'inline_function_call'
        ? bindingSet
        : Object.freeze([]),
    controlKinds: kind === 'wrap_statement_range' || kind === 'convert_control' ? controlKinds : Object.freeze([]),
    branchKinds:
      kind === 'add_branch'
        ? node.semanticKind === 'if'
          ? Object.freeze(['else'] as const)
          : Object.freeze(['switch_case'] as const)
        : kind === 'remove_branch'
          ? branchKinds
          : Object.freeze([]),
    resultVariants:
      kind === 'change_result_variant' || kind === 'add_action_result_branch' ? resultVariants : Object.freeze([]),
    mutabilities: kind === 'change_binding_mutability' ? mutabilities : Object.freeze([]),
    suggestedNames:
      kind === 'rename_symbol' ||
      kind === 'extract_local' ||
      kind === 'extract_function' ||
      kind === 'bind_action_result'
        ? names(node, occupied)
        : Object.freeze([]),
    ownedComments: hasOwnedComments,
  });
}

function limitError(
  limit: keyof SemanticEditCapabilityLimits,
  maximum: number,
  actual: number,
): SemanticEditCapabilityError {
  return Object.freeze({ code: 'capability_limit_exceeded', limit, maximum, actual });
}

/** Projects capability records without serializing or trusting the public graph as edit input. */
export function deriveSemanticEditCapabilities(
  source: SourceProgram,
  graph: SemanticGraph,
  registry: ContractRegistry,
  slot: SlotDefinition,
  scope: SemanticEditCapabilityScope,
  limits: SemanticEditCapabilityLimits,
): DerivedSemanticEditCapabilities | SemanticEditCapabilityError {
  const selectedIds = scope === 'all' ? undefined : new Set(scope.targets);
  const selectedNodes = graph.nodes.filter((node) => !selectedIds || selectedIds.has(node.id));
  if (selectedNodes.length > limits.targets) return limitError('targets', limits.targets, selectedNodes.length);
  const index = indexGraph(graph);
  const document = new EditableSourceDocument(source);
  const occupied = new Set(graph.nodes.flatMap((node) => (node.label ? [node.label] : [])));
  const targets: SemanticEditTargetCapabilities[] = [];
  let capabilityCount = 0;
  for (const node of selectedNodes) {
    const parent = index.parents.get(node.id);
    const container = containerFor(index, node.id);
    const hasOwnedComments = ownedComments(document, node);
    const capabilities = operationKinds(node, index, graph, registry, slot).map((kind) =>
      capability(kind, node, index, graph, registry, slot, occupied, hasOwnedComments),
    );
    capabilityCount += capabilities.length;
    if (capabilityCount > limits.capabilities) return limitError('capabilities', limits.capabilities, capabilityCount);
    targets.push(
      Object.freeze({
        target: node.id,
        kind: node.kind,
        semanticKind: node.semanticKind,
        ...(parent ? { parent } : {}),
        ...(container ? { container } : {}),
        capabilities: Object.freeze(capabilities),
      }),
    );
  }
  let bytes = 0;
  let manifest: SemanticEditCapabilityManifest;
  for (let iteration = 0; ; iteration++) {
    manifest = Object.freeze({
      schema: SEMANTIC_EDIT_SCHEMA,
      graphSchema: graph.schema,
      semanticRevision: graph.semanticRevision,
      sourceHash: graph.sourceHash,
      programHash: graph.programHash,
      compiler: graph.compiler,
      language: graph.language,
      contract: graph.contract,
      slotId: graph.slotId,
      moduleId: graph.moduleId,
      targets: Object.freeze(targets),
      usage: Object.freeze({ targets: targets.length, capabilities: capabilityCount, bytes }),
    });
    const measured = canonicalBytes(manifest).length;
    if (measured === bytes || iteration >= 4) {
      bytes = measured;
      manifest = Object.freeze({ ...manifest, usage: Object.freeze({ ...manifest.usage, bytes }) });
      break;
    }
    bytes = measured;
  }
  const output = canonicalBytes(manifest);
  if (output.length > limits.bytes) return limitError('bytes', limits.bytes, output.length);
  return Object.freeze({ manifest, bytes: output });
}
