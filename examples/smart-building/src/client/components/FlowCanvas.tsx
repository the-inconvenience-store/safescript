import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';

import type { SemanticDiff } from '@safescript/contracts';

import type { BuildingFlow, BuildingFlowNode } from '../../editor/projection.js';

type CanvasNode = Node<BuildingFlowNode & Record<string, unknown>, 'semantic'>;

function SemanticNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const inputs = data.ports.filter(({ direction }) => direction === 'input');
  const outputs = data.ports.filter(({ direction }) => direction === 'output');
  return (
    <article className={`semantic-node semantic-node--${data.type}${selected ? ' is-selected' : ''}`}>
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          title={`${port.edgeKind} input: ${port.label}`}
          style={{ top: `${((index + 1) / (inputs.length + 1)) * 100}%` }}
        />
      ))}
      <span className="node-kicker">{data.type}</span>
      <strong>{data.title}</strong>
      <small>{data.detail}</small>
      <span className="node-capabilities">{data.controls.length} edits</span>
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          title={`${port.edgeKind} output: ${port.label}`}
          style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
        />
      ))}
    </article>
  );
}

const nodeTypes = { semantic: SemanticNodeCard };

const canvasNodes = (flow: BuildingFlow): CanvasNode[] =>
  flow.nodes.map((node) => ({
    id: node.id,
    type: 'semantic',
    position: node.position,
    data: { ...node },
    ariaLabel: `${node.type}: ${node.title}. ${node.controls.length} available edits`,
  }));

const canvasEdges = (flow: BuildingFlow): Edge[] =>
  flow.edges.map((edge) => ({
    ...edge,
    type: edge.kind === 'control' ? 'smoothstep' : 'default',
    animated: edge.kind === 'control' || edge.kind === 'input' || edge.kind === 'output',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { strokeWidth: edge.kind === 'control' ? 2.2 : 1.2 },
  }));

export function FlowCanvas({
  flow,
  diff,
  selected,
  onSelect,
}: Readonly<{
  flow: BuildingFlow;
  diff: SemanticDiff | undefined;
  selected: string | undefined;
  onSelect: (id?: string) => void;
}>) {
  const initialNodes = useMemo(() => canvasNodes(flow), []);
  const initialEdges = useMemo(() => canvasEdges(flow), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      if (diff) {
        for (const entry of diff.entries) {
          const before = entry.before.find((id) => positions.has(id));
          const position = before ? positions.get(before) : undefined;
          if (position) for (const after of entry.after) positions.set(after, position);
        }
      }
      return canvasNodes(flow).map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    });
    setEdges(canvasEdges(flow));
  }, [diff, flow, setEdges, setNodes]);

  return (
    <section className="canvas" aria-label="Semantic program graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(undefined)}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.12}
        maxZoom={1.8}
        colorMode="dark"
      >
        <Background color="#29423e" gap={26} size={1} />
        <MiniMap
          ariaLabel="Semantic graph minimap"
          pannable
          zoomable
          nodeColor={(node) => (node.id === selected ? '#ffc66d' : '#386b61')}
          maskColor="rgba(3, 15, 14, .72)"
        />
        <Controls aria-label="Graph zoom and viewport controls" showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
