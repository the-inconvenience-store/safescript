import { performance } from 'node:perf_hooks';

import {
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  STANDARD_SEMANTIC_GRAPH_LIMITS,
  type ApplySemanticEditsRequest,
  type InspectResult,
  type SemanticEditCapabilityManifest,
  type SemanticEditId,
  type SemanticGraph,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';

import { referenceCheckRequest, walkingSkeletonReference } from '../src/references.js';

interface BenchmarkCase {
  readonly baselineMedianMs: number;
  readonly maximumMedianMs: number;
}

interface BenchmarkEvidence {
  readonly schema: 1;
  readonly release: string;
  readonly adapter: 'direct';
  readonly samples: number;
  readonly baselineEnvironment: string;
  readonly cases: Readonly<Record<string, BenchmarkCase>>;
}

const evidence = (await Bun.file(
  new URL('../evidence/semantic-edit-benchmarks.json', import.meta.url),
).json()) as BenchmarkEvidence;
const bridge = createDirectRuntimeBridge();
const request = referenceCheckRequest(walkingSkeletonReference);
const graphView = {
  kind: 'semantic_graph' as const,
  schema: SEMANTIC_GRAPH_SCHEMA,
  limits: STANDARD_SEMANTIC_GRAPH_LIMITS,
};
const capabilityView = {
  kind: 'semantic_edit_capabilities' as const,
  schema: SEMANTIC_EDIT_SCHEMA,
  scope: 'all' as const,
  limits: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
};

function acceptedView(result: InspectResult, kind: 'semantic_graph' | 'semantic_edit_capabilities') {
  if (result.status !== 'accepted') throw new Error(`${kind} benchmark source was not accepted`);
  const view = result.views.find((candidate) => candidate.kind === kind);
  if (!view || view.status !== 'accepted') throw new Error(`${kind} benchmark view was not accepted`);
  return view;
}

function decode<T>(bytes: readonly number[]): T {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? Number.POSITIVE_INFINITY;
}

async function measure(run: () => Promise<void>): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < evidence.samples; index++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

try {
  const inspected = await bridge.inspect({ ...request, views: [graphView, capabilityView] });
  const graphBytes = acceptedView(inspected, 'semantic_graph').bytes;
  const graph = decode<SemanticGraph>(graphBytes);
  const capabilities = decode<SemanticEditCapabilityManifest>(
    acceptedView(inspected, 'semantic_edit_capabilities').bytes,
  );
  const binding = graph.nodes.find(
    (node) => node.kind === 'binding' && node.semanticKind === 'symbol' && node.label === 'event',
  );
  if (!binding) throw new Error('benchmark graph has no event binding');
  const rename = capabilities.targets
    .find((target) => target.target === binding.id)
    ?.capabilities.find((capability) => capability.kind === 'rename_symbol');
  if (!rename) throw new Error('benchmark capability manifest has no event rename');
  const editRequest: ApplySemanticEditsRequest = {
    ...request,
    editSchema: SEMANTIC_EDIT_SCHEMA,
    graphSchema: SEMANTIC_GRAPH_SCHEMA,
    baseRevision: graph.semanticRevision,
    edits: [
      {
        kind: 'rename_symbol',
        editId: 'edit:benchmark-rename' as SemanticEditId,
        target: binding.id,
        newName: 'benchmarkEvent',
        preconditions: rename.preconditions,
      },
    ],
    editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
    views: [],
  };

  const cases: Readonly<Record<string, () => Promise<void>>> = {
    inspectGraphAndCapabilities: async () => {
      const result = await bridge.inspect({ ...request, views: [graphView, capabilityView] });
      acceptedView(result, 'semantic_graph');
      acceptedView(result, 'semantic_edit_capabilities');
    },
    applyRename: async () => {
      const result = await bridge.applySemanticEdits(editRequest);
      if (result.status !== 'accepted') throw new Error(`rename benchmark returned ${result.status}`);
    },
    rejectSourceLimit: async () => {
      const result = await bridge.check({
        ...request,
        limits: { ...request.limits, sourceBytes: request.source.source.length - 1 },
      });
      if (result.status !== 'rejected') throw new Error(`source-limit benchmark returned ${result.status}`);
    },
    rejectGraphByteLimit: async () => {
      const result = await bridge.inspect({
        ...request,
        views: [{ ...graphView, limits: { ...graphView.limits, bytes: graphBytes.length - 1 } }],
      });
      if (result.status !== 'accepted' || result.views[0]?.status !== 'rejected')
        throw new Error('graph-limit benchmark did not reject its view atomically');
    },
    rejectDiffByteLimit: async () => {
      const result = await bridge.applySemanticEdits({
        ...editRequest,
        editLimits: { ...editRequest.editLimits, diffBytes: 1 },
      });
      if (result.status !== 'rejected' || result.reason !== 'edit_limit_exceeded')
        throw new Error(`diff-limit benchmark returned ${result.status}`);
    },
  };

  const observed: Record<
    string,
    Readonly<{ medianMs: number; baselineMedianMs: number; maximumMedianMs: number }>
  > = {};
  for (const [name, configuration] of Object.entries(evidence.cases)) {
    const run = cases[name];
    if (!run) throw new Error(`benchmark evidence contains unknown case ${name}`);
    await run();
    const medianMs = await measure(run);
    observed[name] = {
      medianMs: Number(medianMs.toFixed(3)),
      baselineMedianMs: configuration.baselineMedianMs,
      maximumMedianMs: configuration.maximumMedianMs,
    };
    if (medianMs > configuration.maximumMedianMs)
      throw new Error(
        `${name} median ${medianMs.toFixed(3)}ms exceeds ${configuration.maximumMedianMs}ms regression ceiling`,
      );
  }

  process.stdout.write(
    `${JSON.stringify({ schema: evidence.schema, release: evidence.release, samples: evidence.samples, observed }, null, 2)}\n`,
  );
} finally {
  await bridge.close();
}
