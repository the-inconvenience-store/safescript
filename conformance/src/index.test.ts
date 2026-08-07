import { describe, expect, it } from 'bun:test';

import {
  STANDARD_EXECUTION_LIMITS,
  checkCompatibility,
  decodeCanonical,
  encodeCanonical,
  ids,
  resultSchema,
  type ActionOutcome,
  type RuntimeBridgeFactory,
  type Schema,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';

import { withRuntimeBridge } from './index.js';
import {
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
  referenceCheckRequest,
  referenceInput,
  referenceRegistry,
  referenceTypes,
  walkingSkeletonReference,
  type ReferenceIntegration,
} from './references.js';

const factory: RuntimeBridgeFactory = createDirectRuntimeBridge;
const references: ReferenceIntegration[] = [
  walkingSkeletonReference,
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
];
const ref = (type: typeof referenceTypes.event): Schema => ({ kind: 'ref', type });

function encode(schema: Schema, value: unknown): readonly number[] {
  const encoded = encodeCanonical(schema, value, { registry: referenceRegistry.schemas });
  if (!encoded.ok) throw new Error(`${encoded.failure.code}:${encoded.failure.path.join('.')}`);
  return [...encoded.value];
}

function invocation(digit: string) {
  return ids.invocation(`invocation:${digit.repeat(32)}`);
}

function executionRequest(
  reference: ReferenceIntegration,
  program:
    | Readonly<{ kind: 'source'; source: ReturnType<typeof referenceCheckRequest> }>
    | Readonly<{ kind: 'artifact'; bytes: readonly number[] }>,
  digit = '1',
) {
  return {
    abiVersion: { major: 1, minor: 0 } as const,
    registry: referenceRegistry,
    slotId: referenceTypes.slotId,
    invocationId: invocation(digit),
    program,
    input: encode(ref(referenceTypes.event), referenceInput),
    limits: STANDARD_EXECUTION_LIMITS,
    idempotencySeed: [1, 2, 3],
    fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
    randomSeed: [1, 2, 3, 4],
    trace: 'semantic' as const,
  };
}

function completedAction(
  request: Parameters<NonNullable<Parameters<ReturnType<RuntimeBridgeFactory>['execute']>[1]>['handleAction']>[0],
): ActionOutcome {
  const operation = referenceRegistry.operations.find((candidate) => candidate.id === request.operationId);
  if (!operation) throw new Error('unknown reference operation');
  const id =
    request.operationId === ids.operation('operation:http.fetch')
      ? '{"ids":["sam","alex"],"next":"page-2"}'
      : String(request.operationId);
  return {
    abiVersion: { major: 1, minor: 0 },
    requestId: request.requestId,
    result: {
      tag: 'completed',
      value: encode(resultSchema(ref(referenceTypes.actionOutput), ref(referenceTypes.actionError)), {
        tag: 'ok',
        value: { id },
      }),
    },
  };
}

describe('runtime bridge conformance corpus', () => {
  it('exercises an injected factory rather than an implementation singleton', () => {
    const first = withRuntimeBridge(factory, (bridge) => bridge);
    const second = withRuntimeBridge(factory, (bridge) => bridge);
    expect(first).not.toBe(second);
  });

  it.each(references)('checks and deterministically inspects the $name reference', async (reference) => {
    const bridge = factory();
    const request = referenceCheckRequest(reference);
    const checked = await bridge.check(request);
    expect(checked.status).toBe('accepted');
    const first = await bridge.inspect({ ...request, views: ['semantic_graph'] });
    const second = await bridge.inspect({ ...request, views: ['semantic_graph'] });
    expect(first.status).toBe('accepted');
    expect(second).toEqual(first);
    if (first.status === 'accepted') {
      const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(first.views.semantic_graph ?? [])));
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(
        new Set(
          graph.nodes
            .filter((node: { semanticKind: string }) => node.semanticKind === 'host-action')
            .map((node: { operationId: string }) => node.operationId),
        ),
      ).toEqual(new Set(reference.expectedOperations));
      expect(
        graph.authorities
          .filter((entry: { kind: string }) => entry.kind === 'effect')
          .map((entry: { id: string }) => entry.id)
          .sort(),
      ).toEqual(reference.expectedOperations.map((operation) => operation.replace('operation:', 'effect:')).sort());
    }
    await bridge.close();
  });

  it.each(references)('executes the $name reference in source and artefact modes', async (reference) => {
    const bridge = factory();
    const checked = await bridge.check(referenceCheckRequest(reference));
    expect(checked.status).toBe('accepted');
    if (checked.status !== 'accepted') return;
    const calls: string[] = [];
    const host = {
      handleAction: async (request: Parameters<typeof completedAction>[0]) => {
        calls.push(request.operationId);
        return completedAction(request);
      },
    };
    const sourceResult = await bridge.execute(
      executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, '2'),
      host,
    );
    const sourceCalls = [...calls];
    calls.length = 0;
    const artifactResult = await bridge.execute(
      executionRequest(reference, { kind: 'artifact', bytes: checked.artifact }, '3'),
      host,
    );
    expect(sourceResult.status).toBe('completed');
    expect(artifactResult.status).toBe('completed');
    expect(new Set(sourceCalls)).toEqual(new Set(reference.expectedOperations));
    expect(calls).toEqual(sourceCalls);
    if (sourceResult.status === 'completed' && artifactResult.status === 'completed') {
      expect(artifactResult.output).toEqual(sourceResult.output);
      expect(
        artifactResult.facts.actions.map((record) =>
          record.phase === 'requested' ? [record.phase, record.request.operationId] : [record.phase],
        ),
      ).toEqual(
        sourceResult.facts.actions.map((record) =>
          record.phase === 'requested' ? [record.phase, record.request.operationId] : [record.phase],
        ),
      );
      expect(artifactResult.facts.usage).toEqual(sourceResult.facts.usage);
    }
    await bridge.close();
  });

  it('regenerates disposable artefacts and semantic graphs from host-owned source', async () => {
    const request = referenceCheckRequest(walkingSkeletonReference);
    const firstBridge = factory();
    const firstCheck = await firstBridge.check(request);
    const firstInspect = await firstBridge.inspect({ ...request, views: ['semantic_graph'] });
    await firstBridge.close();
    const regeneratedCheck = await factory().check(request);
    const regeneratedInspect = await factory().inspect({ ...request, views: ['semantic_graph'] });
    expect(regeneratedCheck).toEqual(firstCheck);
    expect(regeneratedInspect).toEqual(firstInspect);
  });

  it.each([
    ['ambient file authority', 'import { readFile } from "node:fs"\n', 'SS_AMBIENT_AUTHORITY'],
    ['ambient network authority', 'import { fetch } from "node:https"\n', 'SS_AMBIENT_AUTHORITY'],
    ['ambient environment authority', 'const secret = process.env.SECRET\n', 'SS_MODULE_SHAPE'],
    ['dynamic import', 'const loaded = import("some-package")\n', 'SS_DYNAMIC_IMPORT'],
    ['unsafe any', 'function unsafe(value: any): any { return value }\n', 'SS_UNSAFE_TYPE'],
    [
      'exception control flow',
      'function unsafe(): number { try { throw 1 } catch { return 0 } }\n',
      'SS_EXCEPTION_REJECTED',
    ],
    ['generated execution', 'function unsafe(): number { return eval("1") }\n', 'SS_GENERATED_CODE'],
    [
      'mutable value',
      'function unsafe(value: { x: number }): number { value.x = 2; return value.x }\n',
      'SS_VALUE_MUTATION',
    ],
    ['regular expression', 'function unsafe(): boolean { return /x/.test("x") }\n', 'SS_REGEX_REJECTED'],
  ] as const)('rejects the %s language class before execution', async (_name, prefix, expectedCode) => {
    const reference = walkingSkeletonReference;
    const source = reference.source.replace(
      `${reference.source.split('\n')[0]}\n`,
      `${reference.source.split('\n')[0]}\n${prefix}`,
    );
    const result = await factory().check({
      ...referenceCheckRequest(reference),
      source: {
        entry: reference.moduleId,
        modules: [{ id: reference.moduleId, source: [...new TextEncoder().encode(source)] }],
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.diagnostics[0]?.code).toBe(expectedCode);
  });

  it('fails graph export atomically at its independent bound', async () => {
    const request = referenceCheckRequest(applicationExtensionReference);
    const result = await factory().inspect({
      ...request,
      views: ['semantic_graph'],
      graphLimits: { nodes: 1, edges: 1, bytes: 16 },
    });
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(result.viewErrors.semantic_graph?.code).toBe('graph_limit_exceeded');
  });

  it('rejects cross-major and newer-minor compatibility requirements', () => {
    const supported = {
      language: { major: 1, minor: 1 },
      ir: { major: 1, minor: 1 },
      abi: { major: 1, minor: 0 },
      contractId: referenceRegistry.id,
      contract: referenceRegistry.version,
    };
    expect(checkCompatibility(supported, { ...supported, language: { major: 2, minor: 0 } })).toContainEqual({
      code: 'incompatible_version',
      dimension: 'language',
    });
    expect(checkCompatibility(supported, { ...supported, ir: { major: 1, minor: 2 } })).toContainEqual({
      code: 'incompatible_version',
      dimension: 'ir',
    });
  });

  it('fails resource exhaustion before dispatch and never replays an action', async () => {
    let calls = 0;
    const reference = applicationExtensionReference;
    const request = executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, '4');
    const result = await factory().execute(
      { ...request, limits: { ...STANDARD_EXECUTION_LIMITS, concurrentActions: 1 } },
      {
        handleAction: async (action) => {
          calls++;
          return completedAction(action);
        },
      },
    );
    expect(result.status).toBe('failed');
    expect(calls).toBe(1);
    if (result.status === 'failed') {
      expect(result.error.code).toBe('resource_exhausted');
      expect(result.facts.actions.filter(({ phase }) => phase === 'requested')).toHaveLength(1);
    }
  });

  it('preserves request ordering under out-of-order concurrent completion', async () => {
    const reference = applicationExtensionReference;
    const releases: Array<() => void> = [];
    const resultPromise = factory().execute(
      executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, '5'),
      {
        handleAction: (action) => {
          if (action.operationId === ids.operation('operation:tasks.create'))
            return Promise.resolve(completedAction(action));
          return new Promise<ActionOutcome>((resolve) => {
            releases.push(() => resolve(completedAction(action)));
            if (releases.length === 2) {
              releases[1]?.();
              releases[0]?.();
            }
          });
        },
      },
    );
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.facts.actions.map(({ phase }) => phase)).toEqual([
        'requested',
        'resolved',
        'requested',
        'requested',
        'resolved',
        'resolved',
      ]);
    }
  });

  it('cancels an active action once and ignores late completion', async () => {
    const bridge = factory();
    const reference = walkingSkeletonReference;
    let release: (() => void) | undefined;
    const request = executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, '6');
    const execution = bridge.execute(request, {
      handleAction: (action) =>
        new Promise<ActionOutcome>((resolve) => {
          release = () => resolve(completedAction(action));
        }),
    });
    while (!release) await Promise.resolve();
    expect(await bridge.cancel({ abiVersion: { major: 1, minor: 0 }, invocationId: request.invocationId })).toEqual({
      status: 'accepted',
    });
    release();
    const result = await execution;
    expect(result.status).toBe('cancelled');
    expect(await bridge.cancel({ abiVersion: { major: 1, minor: 0 }, invocationId: request.invocationId })).toEqual({
      status: 'not_active',
    });
  });

  it('resumes typed policy rejection but fails closed for host and malformed outcomes', async () => {
    const reference = walkingSkeletonReference;
    const request = executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, '7');
    const actionSchema = resultSchema(ref(referenceTypes.actionOutput), ref(referenceTypes.actionError));
    const rejected = await factory().execute(request, {
      handleAction: async (action) => ({
        abiVersion: { major: 1, minor: 0 },
        requestId: action.requestId,
        result: {
          tag: 'completed',
          value: encode(actionSchema, { tag: 'error', value: { tag: 'policy', value: { code: 'denied' } } }),
        },
      }),
    });
    expect(rejected.status).toBe('completed');
    if (rejected.status === 'completed') {
      const decoded = decodeCanonical(
        resultSchema({ kind: 'unit' }, ref(referenceTypes.actionError)),
        Uint8Array.from(rejected.output),
        { registry: referenceRegistry.schemas },
      );
      expect(decoded.ok && decoded.value).toEqual({
        tag: 'error',
        value: { tag: 'policy', value: { code: 'denied' } },
      });
      expect(rejected.facts.actions.map(({ phase }) => phase)).toEqual(['requested', 'resolved']);
    }

    const hostFailure = await factory().execute(
      { ...request, invocationId: invocation('8') },
      {
        handleAction: async (action) => ({
          abiVersion: { major: 1, minor: 0 },
          requestId: action.requestId,
          result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'unavailable' } } },
        }),
      },
    );
    expect(hostFailure.status).toBe('failed');
    if (hostFailure.status === 'failed') expect(hostFailure.error.code).toBe('unavailable');

    const malformed = await factory().execute(
      { ...request, invocationId: invocation('9') },
      {
        handleAction: async (action) => ({
          abiVersion: { major: 1, minor: 0 },
          requestId: action.requestId,
          result: { tag: 'completed', value: [0] },
        }),
      },
    );
    expect(malformed.status).toBe('failed');
    if (malformed.status === 'failed') expect(malformed.error.code).toBe('action_outcome_invalid');
  });

  it('repeats fixed time, randomness, traces, outputs, and resource charges exactly', async () => {
    const reference = deviceRuleReference;
    const request = executionRequest(reference, { kind: 'source', source: referenceCheckRequest(reference) }, 'a');
    const host = { handleAction: async (action: Parameters<typeof completedAction>[0]) => completedAction(action) };
    const first = await factory().execute(request, host);
    const second = await factory().execute(request, host);
    expect(second).toEqual(first);
  });

  it('round-trips public canonical values and rejects non-canonical bytes', () => {
    const schema = ref(referenceTypes.event);
    const bytes = encode(schema, referenceInput);
    const decoded = decodeCanonical(schema, Uint8Array.from(bytes), { registry: referenceRegistry.schemas });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(encode(schema, decoded.value)).toEqual(bytes);
    expect(decodeCanonical(schema, Uint8Array.from([...bytes, 0]), { registry: referenceRegistry.schemas }).ok).toBe(
      false,
    );
  });
});
