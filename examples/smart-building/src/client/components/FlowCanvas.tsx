import { useCallback, useEffect, useMemo } from 'react';
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

import type { BuildingStepTemplate } from '../../editor/composer.js';
import type { SemanticIntent } from '../../editor/operations.js';
import type { BuildingFlow, BuildingFlowNode } from '../../editor/projection.js';
import { ComposerToolbar } from './ComposerToolbar.js';

type CanvasNodeData = BuildingFlowNode &
  Readonly<{
    busy: boolean;
    onSelect: (id: string) => void;
    onDelete: (target: BuildingFlowNode['semanticId']) => void;
  }> &
  Record<string, unknown>;
type CanvasNode = Node<CanvasNodeData, 'semantic'>;

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
      {(data.controls.length > 0 || data.statementId !== undefined) && (
        <div className="node-actions nodrag nopan">
          <button
            type="button"
            aria-label={`Edit ${data.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              data.onSelect(data.id);
            }}
          >
            Edit
          </button>
          {data.controls.find(({ operation }) => operation === 'delete_target') && (
            <button
              className="node-delete"
              type="button"
              aria-label={`Delete ${data.title}`}
              disabled={data.busy}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                const remove = data.controls.find(({ operation }) => operation === 'delete_target');
                if (remove) data.onDelete(remove.target);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
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

const canvasNodes = (
  flow: BuildingFlow,
  busy: boolean,
  onSelect: (id: string) => void,
  onDelete: (target: BuildingFlowNode['semanticId']) => void,
): CanvasNode[] =>
  flow.nodes.map((node) => ({
    id: node.id,
    type: 'semantic',
    position: node.position,
    data: { ...node, busy, onSelect, onDelete },
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
  templates,
  busy,
  onSelect,
  onEdit,
}: Readonly<{
  flow: BuildingFlow;
  diff: SemanticDiff | undefined;
  selected: string | undefined;
  templates: readonly BuildingStepTemplate[];
  busy: boolean;
  onSelect: (id?: string) => void;
  onEdit: (intent: SemanticIntent) => void;
}>) {
  const remove = useCallback(
    (target: BuildingFlowNode['semanticId']) => onEdit({ kind: 'delete_statement', target }),
    [onEdit],
  );
  const initialNodes = useMemo(() => canvasNodes(flow, busy, onSelect, remove), [busy, flow, onSelect, remove]);
  const initialEdges = useMemo(() => canvasEdges(flow), [flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const compactViewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;

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
      return canvasNodes(flow, busy, onSelect, remove).map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      }));
    });
    setEdges(canvasEdges(flow));
  }, [busy, diff, flow, onSelect, remove, setEdges, setNodes]);

  return (
    <section className="canvas" aria-label="Semantic program graph">
      <ComposerToolbar templates={templates} busy={busy} onEdit={onEdit} />
      <p className="canvas-hint">Drag to explore · scroll to zoom</p>
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
        fitView={!compactViewport}
        defaultViewport={compactViewport ? { x: 24, y: 112, zoom: 0.58 } : { x: 0, y: 0, zoom: 1 }}
        fitViewOptions={{ padding: 0.16, minZoom: 0.58, maxZoom: 1 }}
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
