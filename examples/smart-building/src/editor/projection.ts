import type {
  SemanticEditCapability,
  SemanticEditKind,
  SemanticEditCapabilityManifest,
  SemanticEdgeKind,
  SemanticGraph,
  SemanticGraphNode,
  SemanticNodeId,
} from '@safescript/contracts';

export interface FlowControl {
  readonly operation: SemanticEditKind;
  readonly capability: SemanticEditCapability;
}

export interface FlowPort {
  readonly id: string;
  readonly direction: 'input' | 'output';
  readonly edgeKind: SemanticEdgeKind;
  readonly label: string;
}

export interface BuildingFlowNode {
  readonly id: string;
  readonly semanticId: SemanticNodeId;
  readonly type: 'sensor' | 'rule' | 'calculation' | 'action' | 'value' | 'structure';
  readonly position: Readonly<{ x: number; y: number }>;
  readonly title: string;
  readonly detail: string;
  readonly ports: readonly FlowPort[];
  readonly controls: readonly FlowControl[];
}

export interface BuildingFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string;
  readonly targetHandle: string;
  readonly label: string;
  readonly kind: SemanticEdgeKind;
}

export interface BuildingFlow {
  readonly nodes: readonly BuildingFlowNode[];
  readonly edges: readonly BuildingFlowEdge[];
}

const visible = (node: SemanticGraphNode): boolean =>
  node.editable !== undefined ||
  node.kind === 'action' ||
  node.kind === 'input' ||
  node.kind === 'output' ||
  node.semanticKind === 'statement-container';

const flowType = (node: SemanticGraphNode): BuildingFlowNode['type'] => {
  if (node.semanticKind === 'slot-input') return 'sensor';
  if (node.kind === 'action') return 'action';
  if (['if', 'switch', 'loop', 'for-of', 'for-in', 'branch-case'].includes(node.semanticKind)) return 'rule';
  if (['binary', 'unary', 'variable', 'assign'].includes(node.semanticKind)) return 'calculation';
  if (node.kind === 'constant' || node.semanticKind === 'literal') return 'value';
  return 'structure';
};

const title = (node: SemanticGraphNode): string =>
  node.label ?? node.operationId?.replace('operation:', '') ?? node.semanticKind.replaceAll('-', ' ');

const detail = (node: SemanticGraphNode): string => {
  if (node.operationId) return node.operationId.replace('operation:', 'host · ');
  if (node.constant !== undefined) return JSON.stringify(node.constant);
  if (node.operator) return `operator ${node.operator}`;
  return node.semanticKind;
};

export function projectSemanticEditor(graph: SemanticGraph, manifest: SemanticEditCapabilityManifest): BuildingFlow {
  if (graph.semanticRevision !== manifest.semanticRevision)
    throw new Error('cannot project mismatched semantic revisions');
  const selected = graph.nodes.filter(visible);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const capabilities = new Map(manifest.targets.map((target) => [target.target, target.capabilities]));
  const connected = graph.edges.filter(({ from, to }) => selectedIds.has(from) && selectedIds.has(to));
  const nodes = selected.map((node, index): BuildingFlowNode => {
    const ports: FlowPort[] = [];
    for (const [edgeIndex, edge] of connected.entries()) {
      if (edge.to === node.id)
        ports.push({
          id: `in:${edgeIndex}:${edge.kind}`,
          direction: 'input',
          edgeKind: edge.kind,
          label: edge.role ?? edge.label ?? edge.kind,
        });
      if (edge.from === node.id)
        ports.push({
          id: `out:${edgeIndex}:${edge.kind}`,
          direction: 'output',
          edgeKind: edge.kind,
          label: edge.role ?? edge.label ?? edge.kind,
        });
    }
    return {
      id: node.id,
      semanticId: node.id,
      type: flowType(node),
      position: { x: (index % 4) * 280, y: Math.floor(index / 4) * 170 },
      title: title(node),
      detail: detail(node),
      ports,
      controls: (capabilities.get(node.id) ?? []).map((capability) => ({
        operation: capability.kind,
        capability,
      })),
    };
  });
  const portByEdge = (
    node: BuildingFlowNode,
    direction: FlowPort['direction'],
    index: number,
    kind: SemanticEdgeKind,
  ) => node.ports.find((port) => port.id === `${direction === 'input' ? 'in' : 'out'}:${index}:${kind}`)?.id ?? '';
  const byId = new Map(nodes.map((node) => [node.semanticId, node]));
  const edges = connected.map((edge, index): BuildingFlowEdge => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) throw new Error('projected edge endpoint is missing');
    return {
      id: `${edge.kind}:${edge.from}:${edge.to}:${index}`,
      source: source.id,
      target: target.id,
      sourceHandle: portByEdge(source, 'output', index, edge.kind),
      targetHandle: portByEdge(target, 'input', index, edge.kind),
      label: edge.role ?? edge.label ?? edge.kind,
      kind: edge.kind,
    };
  });
  return { nodes, edges };
}
