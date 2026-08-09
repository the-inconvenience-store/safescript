import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolFrame,
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  encodeWorkerProtocolPayload,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_WORKER_OPERATIONAL_LIMITS,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  type ActionRequest,
  type CheckRequest,
  type RuntimeBridge,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
  type WorkerProtocolSessionHello,
} from '@safescript/contracts';

import { decodeWorkerBridgePayload, encodeWorkerBridgePayload } from './protocol.js';
import { RuntimeWorkerServer } from './server.js';

const digest = '0'.repeat(64);
const versions = Object.freeze({
  abi: Object.freeze([Object.freeze({ major: 2n, minor: 0n })]),
  language: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
  ir: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
  diagnostic_catalog: Object.freeze([Object.freeze({ major: 1n, minor: 0n, patch: 0n })]),
  artifact: Object.freeze([Object.freeze({ major: 1n, minor: 0n })]),
  authoring_bundle: Object.freeze([Object.freeze({ major: 1n, minor: 0n, patch: 0n })]),
});
const hello: WorkerProtocolSessionHello = Object.freeze({
  protocol: Object.freeze({ major: 1n, min_minor: 0n, max_minor: 0n }),
  sdk: Object.freeze({ version: Object.freeze({ major: 1n, minor: 0n, patch: 0n }), build: 'test' }),
  expected_worker: Object.freeze({
    package_version: Object.freeze({ major: 1n, minor: 0n, patch: 0n }),
    build_digest: digest,
    override: false,
  }),
  required_features: Object.freeze([]),
  optional_features: Object.freeze([]),
  versions,
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
});

const checkRequest = {
  abiVersion: { major: 2, minor: 0 },
  languageVersion: { major: 1, minor: 1 },
  registry: {
    abiVersion: { major: 2, minor: 0 },
    id: 'contract:test.worker',
    version: { major: 1, minor: 0, patch: 0 },
    digest,
    schemas: { types: [] },
    effects: [],
    capabilities: [],
    operations: [],
    slots: [],
    definitions: [],
  },
  slotId: 'slot:test.worker',
  source: { entry: 'module:test.worker', modules: [{ id: 'module:test.worker', source: [101, 120] }] },
  limits: STANDARD_COMPILE_LIMITS,
} as unknown as CheckRequest;

const actionRequest = {
  abiVersion: { major: 2, minor: 0 },
  contractId: 'contract:test.worker',
  requiredContractVersion: { major: 1, minor: 0, patch: 0 },
  irDigest: digest,
  invocationId: 'invocation:test.worker',
  requestId: 'request:test.worker',
  slotId: 'slot:test.worker',
  operationId: 'operation:test.worker',
  effectId: 'effect:test.worker',
  capabilityId: 'capability:test.worker',
  actionSiteId: 'action-site:test.worker',
  source: { module: 'module:test.worker', start: 0, end: 1 },
  input: [0xf6],
  idempotencyKey: digest,
} as unknown as ActionRequest;

class FakeBridge implements RuntimeBridge {
  readonly calls: string[] = [];

  async check(request: CheckRequest) {
    this.calls.push(`check:${request.slotId}`);
    return { status: 'bridge_error' as const, error: { code: 'adapter_failure' as const, phase: 'check' as const } };
  }

  async inspect(request: Parameters<RuntimeBridge['inspect']>[0]) {
    this.calls.push(`inspect:${request.views.join(',')}`);
    return { status: 'bridge_error' as const, error: { code: 'adapter_failure' as const, phase: 'inspect' as const } };
  }

  async execute(request: Parameters<RuntimeBridge['execute']>[0], host: Parameters<RuntimeBridge['execute']>[1]) {
    this.calls.push(`execute:${request.invocationId}`);
    const outcome = await host.handleAction(actionRequest);
    this.calls.push(`outcome:${outcome.requestId}`);
    return { status: 'bridge_error' as const, error: { code: 'adapter_failure' as const, phase: 'execute' as const } };
  }

  async cancel(request: Parameters<RuntimeBridge['cancel']>[0]) {
    this.calls.push(`cancel:${request.invocationId}`);
    return { status: 'not_active' as const };
  }

  async close() {
    this.calls.push('close');
    return { status: 'closed' as const };
  }
}

function hostEnvelope(kind: WorkerProtocolMessageKind, id: bigint, payload: Uint8Array, replyTo: bigint | null = null) {
  const envelope = encodeWorkerProtocolEnvelope({ version: 1, kind, id, replyTo, payload });
  if (!envelope.ok) throw new Error(envelope.failure.code);
  const frame = encodeWorkerProtocolFrame(envelope.value);
  if (!frame.ok) throw new Error(frame.failure.code);
  return frame.value;
}

function decodeFrame(frame: Uint8Array): WorkerProtocolEnvelope {
  const unframed = decodeWorkerProtocolFrame(frame);
  if (!unframed.ok) throw new Error(unframed.failure.code);
  const envelope = decodeWorkerProtocolEnvelope(unframed.value);
  if (!envelope.ok) throw new Error(envelope.failure.code);
  return envelope.value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(1);
  if (!predicate()) throw new Error('timed out waiting for worker output');
}

describe('standalone runtime worker server', () => {
  it('refuses to encode legacy v1 action outcomes', () => {
    expect(
      encodeWorkerBridgePayload('action.outcome', {
        request: 1n,
        outcome: {
          abiVersion: { major: 1, minor: 0 },
          requestId: actionRequest.requestId,
          result: { tag: 'rejected', value: { code: 'denied' } },
        },
      } as never).ok,
    ).toBe(false);
  });

  it('round-trips bridge projections without leaking JavaScript numeric or byte representations', () => {
    const encoded = encodeWorkerBridgePayload('bridge.check.request', checkRequest);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeWorkerBridgePayload('bridge.check.request', encoded.value);
    expect(decoded).toEqual({ ok: true, value: checkRequest });
  });

  it('handshakes, multiplexes every bridge operation, suspends actions, and closes cleanly', async () => {
    const frames: Uint8Array[] = [];
    const bridge = new FakeBridge();
    let transportClosed = 0;
    const server = new RuntimeWorkerServer({
      bridge,
      write: (frame) => {
        frames.push(frame);
      },
      close: () => {
        transportClosed++;
      },
    });

    const helloPayload = encodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, hello);
    if (!helloPayload.ok) throw new Error(helloPayload.failure.code);
    await server.receive(hostEnvelope('session.hello', 1n, helloPayload.value));
    await server.drain();
    expect(server.state).toBe('ready');
    const welcomeEnvelope = decodeFrame(frames.shift() as Uint8Array);
    expect(welcomeEnvelope).toMatchObject({ kind: 'session.welcome', replyTo: 1n });
    expect(decodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD, welcomeEnvelope.payload).ok).toBe(true);

    const checkPayload = encodeWorkerBridgePayload('bridge.check.request', checkRequest);
    const inspectPayload = encodeWorkerBridgePayload('bridge.inspect.request', {
      ...checkRequest,
      views: ['semantic_graph'],
    });
    const executePayload = encodeWorkerBridgePayload('bridge.execute.request', {
      abiVersion: { major: 2, minor: 0 },
      registry: checkRequest.registry,
      slotId: checkRequest.slotId,
      invocationId: 'invocation:test.worker' as never,
      program: { kind: 'source', source: checkRequest },
      input: [0xf6],
      limits: STANDARD_EXECUTION_LIMITS,
      trace: 'none',
    });
    if (!checkPayload.ok || !inspectPayload.ok || !executePayload.ok) throw new Error('request encoding failed');
    await server.receive(hostEnvelope('bridge.check.request', 2n, checkPayload.value));
    await server.receive(hostEnvelope('bridge.inspect.request', 3n, inspectPayload.value));
    await server.receive(hostEnvelope('bridge.execute.request', 4n, executePayload.value));
    await waitFor(() => frames.some((frame) => decodeFrame(frame).kind === 'action.request'));

    const actionEnvelope = decodeFrame(
      frames.find((frame) => decodeFrame(frame).kind === 'action.request') as Uint8Array,
    );
    const action = decodeWorkerBridgePayload('action.request', actionEnvelope.payload);
    expect(action.ok && action.value).toMatchObject({ executeId: 4n, request: { requestId: actionRequest.requestId } });
    const outcome = encodeWorkerBridgePayload('action.outcome', {
      request: actionEnvelope.id,
      outcome: {
        abiVersion: { major: 2, minor: 0 },
        requestId: actionRequest.requestId,
        result: { tag: 'completed', value: [0xf6] },
      },
    });
    if (!outcome.ok) throw new Error(outcome.failure.code);
    await server.receive(hostEnvelope('action.outcome', 5n, outcome.value, actionEnvelope.id));
    await server.drain();

    const cancelPayload = encodeWorkerBridgePayload('bridge.cancel.request', {
      abiVersion: { major: 2, minor: 0 },
      invocationId: 'invocation:test.worker' as never,
    });
    const closePayload = encodeWorkerBridgePayload('session.close.request', {});
    if (!cancelPayload.ok || !closePayload.ok) throw new Error('control encoding failed');
    await server.receive(hostEnvelope('bridge.cancel.request', 6n, cancelPayload.value));
    await server.drain();
    await server.receive(hostEnvelope('session.close.request', 7n, closePayload.value));
    await server.drain();

    expect(frames.map((frame) => decodeFrame(frame).kind).sort()).toEqual([
      'action.request',
      'bridge.cancel.result',
      'bridge.check.result',
      'bridge.execute.result',
      'bridge.inspect.result',
      'session.close.result',
    ]);
    expect(bridge.calls).toEqual([
      'check:slot:test.worker',
      'inspect:semantic_graph',
      'execute:invocation:test.worker',
      'outcome:request:test.worker',
      'cancel:invocation:test.worker',
      'close',
    ]);
    expect(server.state).toBe('closed');
    expect(transportClosed).toBe(1);
  });

  it('fails closed on duplicate inbound envelope IDs', async () => {
    const frames: Uint8Array[] = [];
    let closed = 0;
    const server = new RuntimeWorkerServer({
      bridge: new FakeBridge(),
      write: (frame) => {
        frames.push(frame);
      },
      close: () => {
        closed++;
      },
    });
    const payload = encodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, hello);
    if (!payload.ok) throw new Error(payload.failure.code);
    await server.receive(hostEnvelope('session.hello', 1n, payload.value));
    await server.drain();
    await server.receive(hostEnvelope('session.hello', 1n, payload.value));
    await server.drain();
    expect(server.state).toBe('failed');
    expect(closed).toBe(1);
    expect(frames).toHaveLength(1);
  });
});
