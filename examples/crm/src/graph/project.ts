import type { OperationId, SemanticGraph, SemanticGraphEdge, SemanticGraphNode } from '@safescript/contracts';

export interface EditorNode {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly kind: 'handler' | 'control' | 'action' | 'return';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly operationId?: OperationId;
}

export interface ReadonlyNodeEditor {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly EditorNode[];
  readonly edges: readonly SemanticGraphEdge[];
}

interface GraphFacts {
  readonly byId: ReadonlyMap<SemanticGraphNode['id'], SemanticGraphNode>;
  readonly incoming: ReadonlyMap<string, readonly SemanticGraphEdge[]>;
  readonly contained: ReadonlyMap<string, readonly SemanticGraphEdge[]>;
}

const visibleNode = (node: SemanticGraphNode): boolean =>
  node.semanticKind === 'handler' ||
  (node.kind === 'control' && node.semanticKind !== 'return') ||
  node.kind === 'action' ||
  node.semanticKind === 'return-value';

function editorKind(node: SemanticGraphNode): EditorNode['kind'] {
  if (node.kind === 'action') return 'action';
  if (node.kind === 'control') return 'control';
  if (node.semanticKind === 'return-value') return 'return';
  return 'handler';
}

const operatorSymbols: Readonly<Record<string, string>> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  remainder: '%',
  'bit-and': '&',
  'bit-or': '|',
  'bit-xor': '^',
  'shift-left': '<<',
  'shift-right': '>>',
  equal: '===',
  'not-equal': '!==',
  less: '<',
  'less-equal': '<=',
  greater: '>',
  'greater-equal': '>=',
  and: '&&',
  or: '||',
  nullish: '??',
  in: 'in',
  not: '!',
  negate: '−',
  'bit-not': '~',
};

function collectFacts(graph: SemanticGraph): GraphFacts {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, SemanticGraphEdge[]>();
  const contained = new Map<string, SemanticGraphEdge[]>();
  for (const edge of graph.edges) {
    const target = incoming.get(edge.to) ?? [];
    target.push(edge);
    incoming.set(edge.to, target);
    if (edge.kind === 'contains') {
      const children = contained.get(edge.from) ?? [];
      children.push(edge);
      contained.set(edge.from, children);
    }
  }
  return { byId, incoming, contained };
}

function expressionSummary(id: string, facts: GraphFacts, visited: ReadonlySet<string> = new Set()): string {
  if (visited.has(id)) return '…';
  const node = facts.byId.get(id as SemanticGraphNode['id']);
  if (!node) return 'value';

  const nextVisited = new Set(visited).add(id);
  const inputs = (facts.incoming.get(id) ?? []).filter((edge) => edge.kind === 'data' || edge.kind === 'input');
  const child = (label: string): string => {
    const edge = inputs.find((candidate) => candidate.label === label);
    return edge ? expressionSummary(edge.from, facts, nextVisited) : 'value';
  };
  const children = (): string[] => inputs.map((edge) => expressionSummary(edge.from, facts, nextVisited));

  switch (node.semanticKind) {
    case 'literal':
    case 'constant':
      if (node.constant === null) return '';
      if (node.type?.kind === 'int64') return String(node.constant).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
      return JSON.stringify(node.constant);
    case 'name':
      return node.label ?? 'value';
    case 'member':
      return `${child('value')}.${node.label ?? 'field'}`;
    case 'binary':
      return `${child('left')} ${operatorSymbols[node.operator ?? ''] ?? node.operator ?? '?'} ${child('right')}`;
    case 'unary':
      return `${operatorSymbols[node.operator ?? ''] ?? node.operator ?? ''}${child('value')}`;
    case 'object':
      return `{ ${inputs.map((edge) => `${edge.label ?? 'value'}: ${expressionSummary(edge.from, facts, nextVisited)}`).join(', ')} }`;
    case 'array':
      return `[${children().join(', ')}]`;
    case 'template': {
      let value = node.label ?? '';
      for (const edge of inputs) {
        const expression = expressionSummary(edge.from, facts, nextVisited);
        value = value.replace(`\${${edge.label ?? ''}}`, `\${${expression}}`);
      }
      return `\`${value}\``;
    }
    case 'result': {
      const value = child('value');
      return `${node.label === 'error' ? 'Err' : 'Ok'}(${value})`;
    }
    case 'index':
      return `${child('value')}[${child('index')}]`;
    case 'conditional':
      return `${child('condition')} ? ${child('true')} : ${child('false')}`;
    case 'call': {
      const args = inputs
        .filter((edge) => edge.label !== 'callee')
        .map((edge) => expressionSummary(edge.from, facts, nextVisited));
      return `${child('callee')}(${args.join(', ')})`;
    }
    default:
      return node.label ?? node.operator ?? node.semanticKind;
  }
}

function nodeDetail(node: SemanticGraphNode, facts: GraphFacts): string {
  if (node.semanticKind === 'handler') return 'Automation entry point';
  if (node.semanticKind === 'if') {
    const condition = (facts.incoming.get(node.id) ?? []).find(
      (edge) => edge.kind === 'data' && edge.label === 'condition',
    );
    return condition ? expressionSummary(condition.from, facts).replaceAll('event.', '') : 'condition';
  }
  if (node.kind === 'action') {
    const input = (facts.incoming.get(node.id) ?? []).find((edge) => edge.kind === 'input');
    return input ? expressionSummary(input.from, facts) : 'No input';
  }
  if (node.semanticKind === 'return-value') {
    const output = (facts.incoming.get(node.id) ?? []).find((edge) => edge.kind === 'output');
    return output ? expressionSummary(output.from, facts) : 'Return';
  }
  return node.label ?? node.semanticKind;
}

function nodeTitle(node: SemanticGraphNode): string {
  if (node.semanticKind === 'handler') return `${node.label ?? 'run'}(event)`;
  if (node.semanticKind === 'if') return 'IF';
  if (node.kind === 'action') return node.operationId?.replace('operation:', '') ?? 'Host action';
  if (node.semanticKind === 'return-value') return 'RETURN';
  return node.label ?? node.semanticKind.toUpperCase();
}

/** Collapses compiler-only nodes while preserving control flow between visible nodes. */
function projectEdges(graph: SemanticGraph, selected: readonly SemanticGraphNode[]): readonly SemanticGraphEdge[] {
  const facts = collectFacts(graph);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const representative = (
    id: string,
    visited: ReadonlySet<string> = new Set(),
  ): SemanticGraphNode['id'] | undefined => {
    if (selectedIds.has(id as SemanticGraphNode['id'])) return id as SemanticGraphNode['id'];
    if (visited.has(id)) return undefined;
    const nextVisited = new Set(visited).add(id);
    for (const edge of facts.contained.get(id) ?? []) {
      const found = representative(edge.to, nextVisited);
      if (found) return found;
    }
    return undefined;
  };

  const projected: SemanticGraphEdge[] = [];
  const keys = new Set<string>();
  const add = (from: SemanticGraphNode['id'] | undefined, to: SemanticGraphNode['id'] | undefined, label?: string) => {
    if (!from || !to || from === to) return;
    const key = `${from}:${to}:${label ?? ''}`;
    if (keys.has(key)) return;
    keys.add(key);
    projected.push({ kind: 'control', from, to, ...(label === undefined ? {} : { label }) });
  };

  for (const edge of graph.edges) {
    if (edge.kind !== 'control') continue;
    const from = facts.byId.get(edge.from);
    add(
      representative(edge.from),
      representative(edge.to),
      edge.label ?? (from?.semanticKind === 'if' ? 'continue' : undefined),
    );
  }

  for (const parent of selected) {
    if (parent.semanticKind !== 'handler' && parent.semanticKind !== 'if' && parent.semanticKind !== 'switch') continue;
    const children = facts.contained.get(parent.id) ?? [];
    const childIds = new Set(children.map(({ to }) => to));
    const hasSiblingPredecessor = new Set(
      graph.edges
        .filter((edge) => edge.kind === 'control' && childIds.has(edge.from) && childIds.has(edge.to))
        .map(({ to }) => to),
    );
    for (const edge of children) {
      if (!hasSiblingPredecessor.has(edge.to)) add(parent.id, representative(edge.to), edge.label);
    }
  }
  return Object.freeze(projected);
}

/** Converts the public semantic graph into the dashboard's read-only 2D graph. */
export function projectNodeEditor(graph: SemanticGraph): ReadonlyNodeEditor {
  const selected = graph.nodes.filter(visibleNode);
  const facts = collectFacts(graph);
  const edges = projectEdges(graph, selected);

  const incomingCount = new Map(selected.map(({ id }) => [id, 0]));
  for (const edge of edges) incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  const queue = selected.filter(({ id }) => incomingCount.get(id) === 0).map(({ id }) => id);
  const rank = new Map(queue.map((id) => [id, 0]));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current) continue;
    for (const edge of edges.filter(({ from }) => from === current)) {
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(current) ?? 0) + 1));
      const remaining = (incomingCount.get(edge.to) ?? 1) - 1;
      incomingCount.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }

  const rows = new Map<number, SemanticGraphNode[]>();
  for (const node of selected) {
    const nodeRank = rank.get(node.id) ?? 0;
    const row = rows.get(nodeRank) ?? [];
    row.push(node);
    rows.set(nodeRank, row);
  }
  const widestRow = Math.max(...Array.from(rows.values(), (nodes) => nodes.length), 1);
  const maxRank = Math.max(...rows.keys(), 0);
  const width = Math.max(720, widestRow * 340 + 40);
  const height = Math.max(580, 40 + maxRank * 126 + 96 + 40);
  const nodes = Array.from(rows.entries()).flatMap(([nodeRank, row]) => {
    const rowWidth = row.length * 300 + Math.max(0, row.length - 1) * 40;
    const startX = (width - rowWidth) / 2;
    return row.map((node, index) => ({
      id: node.id,
      title: nodeTitle(node),
      detail: nodeDetail(node, facts),
      kind: editorKind(node),
      x: startX + index * 340,
      y: 40 + nodeRank * 126,
      width: 300,
      height: 96,
      ...(node.operationId === undefined ? {} : { operationId: node.operationId }),
    }));
  });

  return Object.freeze({ width, height, nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}
