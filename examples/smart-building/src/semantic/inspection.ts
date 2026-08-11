import {
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  STANDARD_SEMANTIC_GRAPH_LIMITS,
  type InspectViewRequest,
  type SemanticEditCapabilityManifest,
  type SemanticGraph,
} from '@safescript/contracts';

export const EDITOR_VIEWS: readonly InspectViewRequest[] = Object.freeze([
  {
    kind: 'semantic_graph',
    schema: SEMANTIC_GRAPH_SCHEMA,
    limits: STANDARD_SEMANTIC_GRAPH_LIMITS,
  },
  {
    kind: 'semantic_edit_capabilities',
    schema: SEMANTIC_EDIT_SCHEMA,
    scope: 'all',
    limits: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  },
]);

const decode = <T>(bytes: readonly number[]): T => JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T;

export function decodeEditorViews(views: readonly { kind: string; status: string; bytes?: readonly number[] }[]): {
  readonly graph: SemanticGraph;
  readonly capabilities: SemanticEditCapabilityManifest;
} {
  const graphView = views.find((view) => view.kind === 'semantic_graph');
  const capabilityView = views.find((view) => view.kind === 'semantic_edit_capabilities');
  if (graphView?.status !== 'accepted' || !graphView.bytes) throw new Error('semantic graph view was rejected');
  if (capabilityView?.status !== 'accepted' || !capabilityView.bytes)
    throw new Error('semantic edit capability view was rejected');
  const graph = decode<SemanticGraph>(graphView.bytes);
  const capabilities = decode<SemanticEditCapabilityManifest>(capabilityView.bytes);
  if (graph.semanticRevision !== capabilities.semanticRevision)
    throw new Error('semantic graph and capability revisions differ');
  return { graph, capabilities };
}
