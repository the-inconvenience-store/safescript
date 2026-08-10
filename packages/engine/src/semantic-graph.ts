/** Derivation of the bounded public semantic graph from verified compiler output. */
import {
  derivedSemanticNodeId,
  derivedSymbolId,
  hash,
  programHash,
  sourceHash,
  type CheckRequest,
  type CompilerVersion,
  type Schema,
  type SemanticGraph,
  type SemanticGraphEdge,
  type SemanticGraphError,
  type SemanticGraphLimits,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SlotDefinition,
} from '@safescript/contracts';

import type { VerifiedCompilation } from './artifact.js';
import {
  fieldType,
  type StructuredExpression,
  type StructuredProgram,
  type StructuredStatement,
} from './structured-ir.js';

const encoder = new TextEncoder();
const UNIT: Schema = Object.freeze({ kind: 'unit' });
const BOOLEAN: Schema = Object.freeze({ kind: 'boolean' });
const STRING: Schema = Object.freeze({ kind: 'string' });
const INT64: Schema = Object.freeze({ kind: 'int64' });
const FLOAT64: Schema = Object.freeze({ kind: 'float64' });

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

interface DerivedGraph {
  readonly graph: SemanticGraph;
  readonly bytes: readonly number[];
}

class Builder {
  readonly nodes: SemanticGraphNode[] = [];
  readonly edges: SemanticGraphEdge[] = [];
  private readonly paths = new Set<string>();

  constructor(private readonly limits: SemanticGraphLimits) {}

  node(path: string, value: Omit<SemanticGraphNode, 'id'>): SemanticNodeId {
    if (this.paths.has(path)) throw new Error('duplicate semantic graph path');
    this.paths.add(path);
    const id = derivedSemanticNodeId(encoder.encode(path));
    this.nodes.push(Object.freeze({ id, ...value }));
    if (this.nodes.length > this.limits.nodes) throw new GraphLimitFault('nodes', this.limits.nodes, this.nodes.length);
    return id;
  }

  edge(kind: SemanticGraphEdge['kind'], from: SemanticNodeId, to: SemanticNodeId, label?: string): void {
    this.edges.push(Object.freeze({ kind, from, to, ...(label === undefined ? {} : { label }) }));
    if (this.edges.length > this.limits.edges) throw new GraphLimitFault('edges', this.limits.edges, this.edges.length);
  }
}

class GraphLimitFault extends Error {
  constructor(
    readonly limit: keyof SemanticGraphLimits,
    readonly maximum: number,
    readonly actual: number,
  ) {
    super(`semantic graph ${limit} limit exceeded`);
  }
}

interface StructuredContext {
  readonly builder: Builder;
  readonly request: CheckRequest;
  readonly slot: SlotDefinition;
  readonly root: SemanticNodeId;
  readonly bindings: Map<string, Readonly<{ node: SemanticNodeId; type: Schema }>>;
}

function structuredExpression(
  expression: StructuredExpression,
  path: string,
  context: StructuredContext,
  parent: SemanticNodeId,
): Readonly<{ node: SemanticNodeId; type: Schema }> {
  const children: Readonly<{ label: string; value: StructuredExpression }>[] = [];
  let type: Schema = UNIT;
  let binding: Readonly<{ node: SemanticNodeId; type: Schema }> | undefined;
  switch (expression.tag) {
    case 'literal':
      type =
        expression.kind === 'boolean'
          ? BOOLEAN
          : expression.kind === 'int64'
            ? INT64
            : expression.kind === 'float64'
              ? FLOAT64
              : expression.kind === 'string'
                ? STRING
                : UNIT;
      break;
    case 'name':
      binding = context.bindings.get(expression.name);
      type = binding?.type ?? UNIT;
      break;
    case 'member':
      children.push({ label: 'value', value: expression.value });
      type = fieldType(inferStructured(expression.value, context), expression.name, context.request.registry) ?? UNIT;
      break;
    case 'index': {
      children.push({ label: 'value', value: expression.value }, { label: 'index', value: expression.index });
      const source = inferStructured(expression.value, context);
      type = source.kind === 'list' ? source.item : source.kind === 'tuple' ? (source.items[0] ?? UNIT) : UNIT;
      break;
    }
    case 'array': {
      const items = expression.items.map((item) => ('spread' in item ? item.spread : item));
      children.push(...items.map((value, index) => ({ label: String(index), value })));
      type = { kind: 'list', item: items[0] ? inferStructured(items[0], context) : UNIT };
      break;
    }
    case 'object': {
      const fields = expression.fields.flatMap((field, index) => {
        const value = 'spread' in field ? field.spread : field.value;
        children.push({ label: 'spread' in field ? `spread:${index}` : field.name, value });
        return 'spread' in field ? [] : [{ name: field.name, schema: inferStructured(field.value, context) }];
      });
      type = { kind: 'record', fields };
      break;
    }
    case 'template':
      children.push(
        ...expression.parts.flatMap((value, index) =>
          typeof value === 'string' ? [] : [{ label: String(index), value }],
        ),
      );
      type = STRING;
      break;
    case 'unary':
      children.push({ label: 'value', value: expression.value });
      type = expression.operator === 'not' ? BOOLEAN : INT64;
      break;
    case 'binary':
      children.push({ label: 'left', value: expression.left }, { label: 'right', value: expression.right });
      type = ['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal', 'and', 'or', 'in'].includes(
        expression.operator,
      )
        ? BOOLEAN
        : inferStructured(expression.left, context);
      break;
    case 'conditional':
      children.push(
        { label: 'condition', value: expression.condition },
        { label: 'true', value: expression.whenTrue },
        { label: 'false', value: expression.whenFalse },
      );
      type = inferStructured(expression.whenTrue, context);
      break;
    case 'call':
      children.push(
        { label: 'callee', value: expression.callee },
        ...expression.arguments.map((value, index) => ({ label: String(index), value })),
      );
      type = UNIT;
      break;
    case 'function':
      type = UNIT;
      break;
    case 'result':
      children.push({ label: 'value', value: expression.value });
      type = inferStructured(expression.value, context);
      break;
    case 'action': {
      children.push({ label: 'input', value: expression.input });
      const operation = context.request.registry.operations.find(
        (candidate) => candidate.id === expression.operationId,
      );
      type = expression.resultType;
      const node = context.builder.node(path, {
        kind: 'action',
        semanticKind: 'host-action',
        source: expression.source,
        type,
        actionSiteId: expression.actionSiteId,
        operationId: expression.operationId,
        effectId: expression.effectId,
        capabilityId: expression.capabilityId,
        ...(operation ? { effectCost: operation.effectCost, idempotency: operation.idempotency } : {}),
      });
      context.builder.edge('contains', parent, node);
      const input = structuredExpression(expression.input, `${path}/input`, context, node);
      context.builder.edge('input', input.node, node);
      return { node, type };
    }
  }
  const node = context.builder.node(path, {
    kind: expression.tag === 'literal' ? 'constant' : 'expression',
    semanticKind: expression.tag,
    source: expression.source,
    type,
    ...('value' in expression && expression.tag === 'literal' ? { constant: expression.value } : {}),
    ...('operator' in expression ? { operator: expression.operator } : {}),
    ...(expression.tag === 'name' || expression.tag === 'member' ? { label: expression.name } : {}),
    ...(expression.tag === 'result' ? { label: expression.variant } : {}),
    ...(expression.tag === 'template'
      ? {
          label: expression.parts.map((part, index) => (typeof part === 'string' ? part : `\${${index}}`)).join(''),
        }
      : {}),
  });
  context.builder.edge('contains', parent, node);
  if (binding) context.builder.edge('data', binding.node, node, 'binding');
  for (const [index, child] of children.entries()) {
    const derived = structuredExpression(child.value, `${path}/${index}:${child.label}`, context, node);
    context.builder.edge('data', derived.node, node, child.label);
  }
  return { node, type };
}

function inferStructured(expression: StructuredExpression, context: StructuredContext): Schema {
  switch (expression.tag) {
    case 'literal':
      return expression.kind === 'boolean'
        ? BOOLEAN
        : expression.kind === 'int64'
          ? INT64
          : expression.kind === 'float64'
            ? FLOAT64
            : expression.kind === 'string'
              ? STRING
              : UNIT;
    case 'name':
      return context.bindings.get(expression.name)?.type ?? UNIT;
    case 'member':
      return fieldType(inferStructured(expression.value, context), expression.name, context.request.registry) ?? UNIT;
    case 'array': {
      const first = expression.items[0];
      return { kind: 'list', item: first ? inferStructured('spread' in first ? first.spread : first, context) : UNIT };
    }
    case 'object':
      return {
        kind: 'record',
        fields: expression.fields.flatMap((field) =>
          'spread' in field ? [] : [{ name: field.name, schema: inferStructured(field.value, context) }],
        ),
      };
    case 'template':
      return STRING;
    case 'unary':
      return expression.operator === 'not' ? BOOLEAN : INT64;
    case 'binary':
      return ['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal', 'and', 'or', 'in'].includes(
        expression.operator,
      )
        ? BOOLEAN
        : inferStructured(expression.left, context);
    case 'conditional':
      return inferStructured(expression.whenTrue, context);
    case 'action':
      return expression.resultType;
    case 'index': {
      const value = inferStructured(expression.value, context);
      return value.kind === 'list' ? value.item : value.kind === 'tuple' ? (value.items[0] ?? UNIT) : UNIT;
    }
    case 'result':
      return inferStructured(expression.value, context);
    case 'call':
    case 'function':
      return UNIT;
  }
}

function structuredStatements(
  statements: readonly StructuredStatement[],
  path: string,
  context: StructuredContext,
  parent: SemanticNodeId,
  relation?: string,
): void {
  let previous: SemanticNodeId | undefined;
  for (const [index, statement] of statements.entries()) {
    const statementPath = `${path}/${index}:${statement.tag}`;
    const node = context.builder.node(statementPath, {
      kind: statement.tag === 'variable' || statement.tag === 'destructure' ? 'declaration' : 'control',
      semanticKind: statement.tag,
      source: statement.source,
      ...('name' in statement ? { label: statement.name } : {}),
      ...(statement.tag === 'variable'
        ? { symbolId: derivedSymbolId(encoder.encode(`${context.request.source.entry}:${path}:${statement.name}`)) }
        : {}),
    });
    context.builder.edge('contains', parent, node, relation);
    if (previous) context.builder.edge('control', previous, node);
    previous = node;
    if (statement.tag === 'variable') {
      const value = structuredExpression(statement.value, `${statementPath}/value`, context, node);
      context.bindings.set(statement.name, { node, type: value.type });
      context.builder.edge('data', value.node, node);
    } else if (statement.tag === 'destructure') {
      const value = structuredExpression(statement.value, `${statementPath}/value`, context, node);
      context.builder.edge('data', value.node, node);
    } else if (statement.tag === 'assign') {
      const value = structuredExpression(statement.value, `${statementPath}/value`, context, node);
      const target = context.bindings.get(statement.name);
      if (target) context.builder.edge('data', target.node, node, 'target');
      context.builder.edge('data', value.node, node, 'value');
    } else if (statement.tag === 'expression') {
      structuredExpression(statement.expression, `${statementPath}/expression`, context, node);
    } else if (statement.tag === 'if') {
      const condition = structuredExpression(statement.condition, `${statementPath}/condition`, context, node);
      context.builder.edge('data', condition.node, node, 'condition');
      structuredStatements(statement.whenTrue, `${statementPath}/true`, context, node, 'true');
      structuredStatements(statement.whenFalse, `${statementPath}/false`, context, node, 'false');
    } else if (statement.tag === 'for-of' || statement.tag === 'for-in') {
      const value = structuredExpression(
        statement.tag === 'for-of' ? statement.values : statement.value,
        `${statementPath}/iterable`,
        context,
        node,
      );
      context.bindings.set(statement.name, { node, type: value.type.kind === 'list' ? value.type.item : STRING });
      structuredStatements(statement.body, `${statementPath}/body`, context, node, 'body');
    } else if (statement.tag === 'loop') {
      structuredStatements(statement.initializer, `${statementPath}/initializer`, context, node, 'initializer');
      const condition = structuredExpression(statement.condition, `${statementPath}/condition`, context, node);
      context.builder.edge('data', condition.node, node, 'condition');
      structuredStatements(statement.body, `${statementPath}/body`, context, node, 'body');
      structuredStatements(statement.increment, `${statementPath}/increment`, context, node, 'increment');
    } else if (statement.tag === 'return') {
      const value = structuredExpression(statement.value, `${statementPath}/value`, context, node);
      const output = context.builder.node(`${statementPath}/output`, {
        kind: 'output',
        semanticKind: 'return-value',
        source: statement.source,
        type: {
          kind: 'ref',
          type: context.slot.output,
        },
      });
      context.builder.edge('contains', node, output);
      context.builder.edge('output', value.node, output);
    } else if (statement.tag === 'switch') {
      const value = structuredExpression(statement.value, `${statementPath}/value`, context, node);
      context.builder.edge('data', value.node, node, 'value');
      statement.cases.forEach((item, caseIndex) =>
        structuredStatements(item.body, `${statementPath}/case/${caseIndex}:${item.value}`, context, node, item.value),
      );
    }
  }
}

function deriveStructured(
  builder: Builder,
  program: StructuredProgram,
  root: SemanticNodeId,
  request: CheckRequest,
  slot: SlotDefinition,
): void {
  const bindings = new Map<string, Readonly<{ node: SemanticNodeId; type: Schema }>>();
  const input = builder.node('program/input', {
    kind: 'input',
    semanticKind: 'slot-input',
    label: program.eventParameter,
    type: { kind: 'ref', type: slot.input },
  });
  builder.edge('contains', root, input);
  bindings.set(program.eventParameter, { node: input, type: { kind: 'ref', type: slot.input } });
  const context: StructuredContext = { builder, request, slot, root, bindings };
  for (const [index, fn] of program.functions.entries()) {
    const path = `program/declaration/${index}:${fn.name}`;
    const declaration = builder.node(path, {
      kind: 'declaration',
      semanticKind: fn.name === program.handler ? 'handler' : 'function',
      label: fn.name,
      source: fn.source,
      symbolId: derivedSymbolId(encoder.encode(`${request.source.entry}:function:${fn.name}`)),
      ...(fn.name === program.handler ? { type: { kind: 'ref' as const, type: slot.output } } : {}),
    });
    builder.edge('contains', root, declaration);
    structuredStatements(fn.body, `${path}/body`, context, declaration);
  }
}

/** Builds and canonically serialises a complete graph, or reports one independent export limit. */
export function deriveSemanticGraph(
  request: CheckRequest,
  slot: SlotDefinition,
  artifact: VerifiedCompilation,
  compiler: CompilerVersion,
  limits: SemanticGraphLimits,
): DerivedGraph | SemanticGraphError {
  const builder = new Builder(limits);
  let root: SemanticNodeId;
  try {
    root = builder.node(`program:${request.source.entry}:${artifact.handler}`, {
      kind: 'declaration',
      semanticKind: 'program',
      label: artifact.handler,
      symbolId: derivedSymbolId(encoder.encode(`${request.source.entry}:handler:${artifact.handler}`)),
    });
    deriveStructured(builder, artifact.program.program, root, request, slot);
  } catch (error) {
    if (error instanceof GraphLimitFault)
      return { code: 'graph_limit_exceeded', limit: error.limit, maximum: error.maximum, actual: error.actual };
    throw error;
  }

  if (builder.nodes.length > limits.nodes)
    return { code: 'graph_limit_exceeded', limit: 'nodes', maximum: limits.nodes, actual: builder.nodes.length };
  if (builder.edges.length > limits.edges)
    return { code: 'graph_limit_exceeded', limit: 'edges', maximum: limits.edges, actual: builder.edges.length };
  const sourceProgramHash = programHash(request.source);
  if (!sourceProgramHash.ok) throw new Error('accepted source has no program hash');
  const sources = [...request.source.modules]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((module) => Object.freeze({ module: module.id, hash: sourceHash(Uint8Array.from(module.source)) }));
  const declarationNodes = builder.nodes.filter((node) => node.kind === 'declaration').map((node) => node.id);
  const expressionNodes = builder.nodes
    .filter((node) => node.kind === 'expression' || node.kind === 'constant')
    .map((node) => node.id);
  const controlNodes = builder.nodes.filter((node) => node.kind === 'control').map((node) => node.id);
  const actionNodes = builder.nodes.filter((node) => node.kind === 'action').map((node) => node.id);
  const authorities = [
    ...artifact.program.program.summary.effects.map((id) => ({
      kind: 'effect' as const,
      id,
      actionNodes: builder.nodes.filter((node) => node.effectId === id).map((node) => node.id),
    })),
    ...artifact.program.program.summary.capabilities.map((id) => ({
      kind: 'capability' as const,
      id,
      actionNodes: builder.nodes.filter((node) => node.capabilityId === id).map((node) => node.id),
    })),
  ];
  const graph: SemanticGraph = Object.freeze({
    sourceHash: hash('source', encoder.encode(canonical(sources))) as unknown as SemanticGraph['sourceHash'],
    programHash: sourceProgramHash.value,
    compiler,
    contract: Object.freeze({
      id: request.registry.id,
      digest: request.registry.digest,
    }),
    slotId: request.slotId,
    entryModule: request.source.entry,
    root,
    nodes: Object.freeze(builder.nodes),
    edges: Object.freeze(builder.edges),
    effects: artifact.program.program.summary.effects,
    capabilities: artifact.program.program.summary.capabilities,
    authorities: Object.freeze(authorities.map((authority) => Object.freeze(authority))),
    resources: Object.freeze({
      declarations: declarationNodes.length,
      expressions: expressionNodes.length,
      controlPoints: controlNodes.length,
      actionSites: actionNodes.length,
      potentialEffectCost: builder.nodes.reduce((total, node) => total + (node.effectCost ?? 0), 0),
      declarationNodes: Object.freeze(declarationNodes),
      expressionNodes: Object.freeze(expressionNodes),
      controlNodes: Object.freeze(controlNodes),
      actionNodes: Object.freeze(actionNodes),
    }),
    sources: Object.freeze(sources),
  });
  const bytes = Object.freeze(Array.from(encoder.encode(canonical(graph))));
  if (bytes.length > limits.bytes)
    return { code: 'graph_limit_exceeded', limit: 'bytes', maximum: limits.bytes, actual: bytes.length };
  return { graph, bytes };
}
