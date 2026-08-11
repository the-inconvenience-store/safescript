/** Bounded public semantic-graph projection over the private checked semantic model. */
import {
  LANGUAGE_PROFILE,
  SEMANTIC_GRAPH_SCHEMA,
  derivedSemanticRevisionId,
  programHash,
  sourceHash,
  type CheckRequest,
  type CompilerVersion,
  type SemanticGraph,
  type SemanticGraphError,
  type SemanticGraphLimits,
  type SlotDefinition,
} from '@safescript/contracts';

import type { VerifiedCompilation } from './artifact.js';
import { buildSemanticModel, SemanticModelLimitError, type CheckedSemanticModel } from './semantic-model.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

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

class CanonicalByteLimitError extends Error {
  constructor(readonly maximum: number) {
    super('semantic graph byte limit exceeded');
  }
}

/** Serialises canonical JSON incrementally so a small byte ceiling bounds retained export work. */
function boundedCanonicalBytes(value: unknown, maximum: number): readonly number[] {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const write = (text: string): void => {
    const chunk = encoder.encode(text);
    if (length + chunk.length > maximum) throw new CanonicalByteLimitError(maximum);
    chunks.push(chunk);
    length += chunk.length;
  };
  const visit = (item: unknown): void => {
    if (typeof item === 'bigint') {
      write('{"$int64":');
      write(JSON.stringify(String(item)));
      write('}');
      return;
    }
    if (Array.isArray(item)) {
      write('[');
      item.forEach((child, index) => {
        if (index > 0) write(',');
        visit(child);
      });
      write(']');
      return;
    }
    if (item !== null && typeof item === 'object') {
      write('{');
      Object.entries(item)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .forEach(([key, child], index) => {
          if (index > 0) write(',');
          write(JSON.stringify(key));
          write(':');
          visit(child);
        });
      write('}');
      return;
    }
    const scalar = JSON.stringify(item);
    if (scalar === undefined) throw new Error('canonical graph contains an unsupported scalar');
    write(scalar);
  };
  visit(value);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return Object.freeze(Array.from(output));
}

interface DerivedGraph {
  readonly graph: SemanticGraph;
  readonly bytes: readonly number[];
}

function limitError(limit: keyof SemanticGraphLimits, maximum: number, actual: number): SemanticGraphError | undefined {
  return actual > maximum ? { code: 'graph_limit_exceeded', limit, maximum, actual } : undefined;
}

/** Builds and canonically serialises a complete graph, or reports one independent export limit atomically. */
export function deriveSemanticGraph(
  request: CheckRequest,
  slot: SlotDefinition,
  artifact: VerifiedCompilation,
  compiler: CompilerVersion,
  limits: SemanticGraphLimits,
): DerivedGraph | SemanticGraphError {
  const source = decoder.decode(Uint8Array.from(request.source.source));
  let model: CheckedSemanticModel;
  try {
    model = buildSemanticModel(source, request, slot, artifact, limits);
  } catch (error) {
    if (error instanceof SemanticModelLimitError)
      return {
        code: 'graph_limit_exceeded',
        limit: error.limit,
        maximum: error.maximum,
        actual: error.actual,
      };
    throw error;
  }
  const nodeError = limitError('nodes', limits.nodes, model.nodes.length);
  if (nodeError) return nodeError;
  const edgeError = limitError('edges', limits.edges, model.edges.length);
  if (edgeError) return edgeError;

  const sourceProgramHash = programHash(request.source);
  if (!sourceProgramHash.ok) throw new Error('accepted source has no program hash');
  const sourceDigest = sourceHash(Uint8Array.from(request.source.source));
  const semanticRevision = derivedSemanticRevisionId(
    encoder.encode(
      canonical({
        schema: SEMANTIC_GRAPH_SCHEMA,
        sourceHash: sourceDigest,
        programHash: sourceProgramHash.value,
        compiler,
        language: LANGUAGE_PROFILE,
        contract: request.registry.digest,
        slot: request.slotId,
        module: request.source.module,
      }),
    ),
  );
  const declarationNodes = model.nodes
    .filter((node) => node.kind === 'declaration' || node.kind === 'binding' || node.kind === 'type')
    .map((node) => node.id);
  const expressionNodes = model.nodes
    .filter((node) => node.kind === 'expression' || node.kind === 'constant')
    .map((node) => node.id);
  const controlNodes = model.nodes
    .filter((node) => node.kind === 'statement' || node.kind === 'branch' || node.kind === 'case')
    .map((node) => node.id);
  const actionNodes = model.nodes.filter((node) => node.kind === 'action').map((node) => node.id);
  const graph: SemanticGraph = Object.freeze({
    schema: SEMANTIC_GRAPH_SCHEMA,
    semanticRevision,
    sourceHash: sourceDigest,
    programHash: sourceProgramHash.value,
    compiler,
    language: LANGUAGE_PROFILE,
    contract: Object.freeze({ id: request.registry.id, digest: request.registry.digest }),
    slotId: request.slotId,
    moduleId: request.source.module,
    root: model.root,
    nodes: model.nodes,
    edges: model.edges,
    anchors: model.anchors,
    operations: artifact.program.program.summary.operations,
    resources: Object.freeze({
      declarations: declarationNodes.length,
      expressions: expressionNodes.length,
      controlPoints: controlNodes.length,
      actionSites: actionNodes.length,
      potentialEffectCost: model.nodes.reduce((total, node) => total + (node.effectCost ?? 0), 0),
      declarationNodes: Object.freeze(declarationNodes),
      expressionNodes: Object.freeze(expressionNodes),
      controlNodes: Object.freeze(controlNodes),
      actionNodes: Object.freeze(actionNodes),
    }),
  });
  try {
    return { graph, bytes: boundedCanonicalBytes(graph, limits.bytes) };
  } catch (error) {
    if (error instanceof CanonicalByteLimitError)
      return {
        code: 'graph_limit_exceeded',
        limit: 'bytes',
        maximum: error.maximum,
        actual: error.maximum + 1,
      };
    throw error;
  }
}
