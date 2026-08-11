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
  readonly target: SemanticNodeId;
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
  readonly statementId?: SemanticNodeId;
  readonly type: 'sensor' | 'rule' | 'calculation' | 'action' | 'output';
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

export interface BuildingComposer {
  readonly container: SemanticNodeId;
  readonly children: readonly SemanticNodeId[];
  readonly insertionIndex: number;
  readonly controls: readonly FlowControl[];
}

export interface BuildingFlow {
  readonly nodes: readonly BuildingFlowNode[];
  readonly edges: readonly BuildingFlowEdge[];
  readonly composer?: BuildingComposer;
}

const editableKinds = new Set<SemanticEditKind>([
  'set_literal_value',
  'rename_symbol',
  'replace_target',
  'change_operator',
  'change_action_operation',
  'set_action_input_field',
  'delete_target',
]);

const actionTitle = (operationId: string | undefined): string => {
  switch (operationId) {
    case 'operation:hvac.set':
      return 'Set HVAC';
    case 'operation:lighting.set':
      return 'Set lighting';
    case 'operation:alerts.send':
      return 'Send alert';
    case 'operation:audit.record':
      return 'Record audit';
    default:
      return operationId?.replace('operation:', '').replaceAll('.', ' ') ?? 'Host action';
  }
};

const words = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, (_match, before: string, after: string) => `${before} ${after.toLowerCase()}`)
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());

function sourceReader(source: string) {
  const bytes = new TextEncoder().encode(source);
  const decoder = new TextDecoder();
  return (node: SemanticGraphNode | undefined): string =>
    node?.source === undefined ? '' : decoder.decode(bytes.slice(node.source.start, node.source.end)).trim();
}

function descendants(graph: SemanticGraph, root: SemanticNodeId): readonly SemanticNodeId[] {
  const children = new Map<SemanticNodeId, SemanticNodeId[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') continue;
    const current = children.get(edge.from) ?? [];
    current.push(edge.to);
    children.set(edge.from, current);
  }
  const found: SemanticNodeId[] = [];
  const pending = [...(children.get(root) ?? [])];
  const seen = new Set<SemanticNodeId>();
  while (pending.length > 0) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    found.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return found;
}

function executionBody(graph: SemanticGraph): SemanticGraphNode | undefined {
  const childCount = (id: SemanticNodeId) =>
    graph.edges.filter(({ kind, from, index }) => kind === 'contains' && from === id && index !== undefined).length;
  return graph.nodes
    .filter(({ semanticKind, label }) => semanticKind === 'statement-container' && label === 'body')
    .sort((left, right) => childCount(right.id) - childCount(left.id))[0];
}

export function projectSemanticEditor(
  graph: SemanticGraph,
  manifest: SemanticEditCapabilityManifest,
  source = '',
): BuildingFlow {
  if (graph.semanticRevision !== manifest.semanticRevision)
    throw new Error('cannot project mismatched semantic revisions');

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const read = sourceReader(source);
  const body = executionBody(graph);
  const bodyChildren = body
    ? graph.edges
        .filter(({ kind, from, index }) => kind === 'contains' && from === body.id && index !== undefined)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map(({ to }) => to)
    : [];
  const targetCapabilities = new Map(manifest.targets.map((target) => [target.target, target.capabilities]));
  const parents = new Map<SemanticNodeId, SemanticNodeId>();
  for (const edge of graph.edges) if (edge.kind === 'contains') parents.set(edge.to, edge.from);

  const statementFor = (id: SemanticNodeId): SemanticNodeId | undefined => {
    let current: SemanticNodeId | undefined = id;
    while (current && current !== body?.id) {
      if (bodyChildren.includes(current)) return current;
      current = parents.get(current);
    }
    return undefined;
  };
  const actionIds = new Set(graph.nodes.filter(({ kind }) => kind === 'action').map(({ id }) => id));
  const actionDescendants = (id: SemanticNodeId) =>
    descendants(graph, id).filter((candidate) => actionIds.has(candidate));
  const conditionFor = (id: SemanticNodeId) => {
    const condition = graph.edges.find(
      ({ from, kind, role }) => from === id && kind === 'contains' && role === 'condition',
    )?.to;
    return condition === undefined ? undefined : byId.get(condition);
  };
  const isErrorGuard = (node: SemanticGraphNode) => {
    const condition = read(conditionFor(node.id));
    return condition.includes('.tag') && condition.includes('"error"');
  };

  const selected: SemanticGraphNode[] = [];
  selected.push(...graph.nodes.filter(({ semanticKind }) => semanticKind === 'slot-input'));
  for (const id of bodyChildren) {
    const node = byId.get(id);
    if (!node) continue;
    const actions = actionDescendants(id)
      .map((actionId) => byId.get(actionId))
      .filter((item) => item !== undefined);
    if (node.semanticKind === 'variable' && actions.length === 0) selected.push(node);
    if (node.semanticKind === 'if' && !isErrorGuard(node)) selected.push(node);
    selected.push(...actions);
  }
  selected.push(...graph.nodes.filter(({ semanticKind }) => semanticKind === 'slot-output'));

  const controlScope = (node: SemanticGraphNode): readonly SemanticNodeId[] => {
    if (node.kind === 'action') return [node.id];
    if (node.semanticKind === 'if') {
      const condition = conditionFor(node.id);
      return condition ? [node.id, condition.id, ...descendants(graph, condition.id)] : [node.id];
    }
    if (node.kind === 'statement') return [node.id, ...descendants(graph, node.id)];
    return [node.id];
  };
  const controlsFor = (node: SemanticGraphNode): readonly FlowControl[] => {
    const controls: FlowControl[] = [];
    const included = new Set<SemanticEditKind>();
    for (const target of controlScope(node)) {
      for (const capability of targetCapabilities.get(target) ?? []) {
        if (!editableKinds.has(capability.kind) || included.has(capability.kind)) continue;
        if (node.kind === 'action' && capability.kind === 'delete_target') continue;
        if (
          capability.kind === 'replace_target' &&
          !capability.fragmentCategories.includes(node.semanticKind === 'if' ? 'expression' : 'statement')
        )
          continue;
        included.add(capability.kind);
        controls.push({ target, operation: capability.kind, capability });
      }
    }
    return controls;
  };

  const nodeType = (node: SemanticGraphNode): BuildingFlowNode['type'] => {
    if (node.semanticKind === 'slot-input') return 'sensor';
    if (node.semanticKind === 'slot-output') return 'output';
    if (node.kind === 'action') return 'action';
    if (node.semanticKind === 'if') return 'rule';
    return 'calculation';
  };
  const nodeTitle = (node: SemanticGraphNode): string => {
    if (node.semanticKind === 'slot-input') return 'Sensor event';
    if (node.semanticKind === 'slot-output') return 'Successful result';
    if (node.kind === 'action') return actionTitle(node.operationId);
    if (node.semanticKind === 'if') {
      const action = actionDescendants(node.id)
        .map((id) => byId.get(id))
        .find((item) => item?.kind === 'action');
      return `${words(actionTitle(action?.operationId).replace(/^Set /, ''))} rule`;
    }
    const match = /^const\s+([A-Za-z_$][\w$]*)/.exec(read(node));
    return words(match?.[1] ?? node.label ?? 'Calculation');
  };
  const nodeDetail = (node: SemanticGraphNode): string => {
    if (node.semanticKind === 'slot-input') return 'Building sensor telemetry';
    if (node.semanticKind === 'slot-output') return 'Checked program result';
    if (node.semanticKind === 'if') return `When ${read(conditionFor(node.id))}`;
    if (node.kind === 'action') {
      const value = /\bvalue:\s*([^,\n}]+)/.exec(read(node))?.[1];
      return value ? `Value · ${value}` : (node.operationId?.replace('operation:', 'Host · ') ?? 'Host action');
    }
    const statement = read(node);
    return statement.includes('=') ? statement.slice(statement.indexOf('=') + 1).trim() : statement;
  };

  type ProjectedEdge = Readonly<{
    from: SemanticNodeId;
    to: SemanticNodeId;
    kind: SemanticEdgeKind;
    label: string;
  }>;
  const projectedEdges: ProjectedEdge[] = [];
  for (let index = 1; index < selected.length; index += 1) {
    const before = selected[index - 1];
    const after = selected[index];
    if (!before || !after) continue;
    const beforeStatement = statementFor(before.id);
    const afterStatement = statementFor(after.id);
    const kind: SemanticEdgeKind =
      before.semanticKind === 'slot-input'
        ? 'input'
        : after.semanticKind === 'slot-output'
          ? 'output'
          : beforeStatement !== undefined && beforeStatement === afterStatement
            ? 'contains'
            : 'control';
    projectedEdges.push({
      from: before.id,
      to: after.id,
      kind,
      label: kind === 'contains' ? 'then' : kind === 'input' ? 'sensor data' : kind === 'output' ? 'result' : 'next',
    });
  }

  const portsByNode = new Map<SemanticNodeId, FlowPort[]>();
  for (const [index, edge] of projectedEdges.entries()) {
    const sourcePorts = portsByNode.get(edge.from) ?? [];
    sourcePorts.push({
      id: `out:${index}:${edge.kind}`,
      direction: 'output',
      edgeKind: edge.kind,
      label: edge.label,
    });
    portsByNode.set(edge.from, sourcePorts);
    const targetPorts = portsByNode.get(edge.to) ?? [];
    targetPorts.push({
      id: `in:${index}:${edge.kind}`,
      direction: 'input',
      edgeKind: edge.kind,
      label: edge.label,
    });
    portsByNode.set(edge.to, targetPorts);
  }
  const columns: Record<BuildingFlowNode['type'], number> = {
    sensor: 0,
    calculation: 0,
    rule: 1,
    action: 2,
    output: 3,
  };
  const rows = new Map<BuildingFlowNode['type'], number>();
  const nodes = selected.map((node): BuildingFlowNode => {
    const type = nodeType(node);
    const column = columns[type];
    const row = rows.get(type) ?? 0;
    const statementId = statementFor(node.id);
    rows.set(type, row + 1);
    const y =
      type === 'sensor' ? 0 : type === 'calculation' ? 160 + row * 180 : type === 'output' ? 240 : 70 + row * 190;
    return {
      id: node.id,
      semanticId: node.id,
      ...(statementId === undefined ? {} : { statementId }),
      type,
      position: { x: column * 255, y },
      title: nodeTitle(node),
      detail: nodeDetail(node),
      ports: portsByNode.get(node.id) ?? [],
      controls: controlsFor(node),
    };
  });
  const edges = projectedEdges.map((edge, index): BuildingFlowEdge => ({
    id: `${edge.kind}:${edge.from}:${edge.to}:${index}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: `out:${index}:${edge.kind}`,
    targetHandle: `in:${index}:${edge.kind}`,
    label: edge.label,
    kind: edge.kind,
  }));
  const composerControls: FlowControl[] = [];
  if (body) {
    for (const capability of targetCapabilities.get(body.id) ?? [])
      composerControls.push({ target: body.id, operation: capability.kind, capability });
  }
  const finalReturnIndex = bodyChildren.findIndex((id) => byId.get(id)?.semanticKind === 'return');
  return {
    nodes,
    edges,
    ...(body === undefined
      ? {}
      : {
          composer: {
            container: body.id,
            children: bodyChildren,
            insertionIndex: finalReturnIndex < 0 ? bodyChildren.length : finalReturnIndex,
            controls: composerControls,
          },
        }),
  };
}
