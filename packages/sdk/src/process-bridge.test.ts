import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolFrame,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  encodeWorkerProtocolPayload,
  negotiateWorkerProtocolHandshake,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  type ActionRequest,
  type CheckRequest,
  type RuntimeBridge,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
} from '@safescript/contracts';
import { DEFAULT_WORKER_HANDSHAKE_SUPPORT, encodeWorkerBridgePayload, RuntimeWorkerServer } from '@safescript/worker';

import { DEFAULT_PROCESS_WORKER_HELLO, ProcessRuntimeBridge, type ProcessWorkerTransport } from './process-bridge.js';

const digest = '0'.repeat(64);
const checkRequest = {
  abiVersion: { major: 2, minor: 0 },
  languageVersion: { major: 1, minor: 1 },
  registry: {
    abiVersion: { major: 2, minor: 0 },
    id: 'contract:test.process-bridge',
    version: { major: 1, minor: 0, patch: 0 },
    digest,
    schemas: { types: [] },
    effects: [],
    capabilities: [],
    operations: [],
    slots: [],
    definitions: [],
  },
  slotId: 'slot:test.process-bridge',
  source: {
    entry: 'module:test.process-bridge',
    modules: [{ id: 'module:test.process-bridge', source: [101, 120] }],
  },
  limits: STANDARD_COMPILE_LIMITS,
} as unknown as CheckRequest;

const actionRequest = {
  abiVersion: { major: 2, minor: 0 },
  contractId: 'contract:test.process-bridge',
  requiredContractVersion: { major: 1, minor: 0, patch: 0 },
  irDigest: digest,
  invocationId: 'invocation:11111111111111111111111111111111',
  requestId: 'request:11111111111111111111111111111111:0',
  slotId: 'slot:test.process-bridge',
  operationId: 'operation:test.process-bridge',
  effectId: 'effect:test.process-bridge',
  capabilityId: 'capability:test.process-bridge',
  actionSiteId: `action-site:${digest}`,
  source: { module: 'module:test.process-bridge', start: 0, end: 1 },
  input: [0xf6],
} as unknown as ActionRequest;

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  push(value: Uint8Array): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

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

function decodeFrame(frame: Uint8Array): WorkerProtocolEnvelope {
  const decodedFrame = decodeWorkerProtocolFrame(frame);
  if (!decodedFrame.ok) throw new Error(decodedFrame.failure.code);
  const decoded = decodeWorkerProtocolEnvelope(decodedFrame.value);
  if (!decoded.ok) throw new Error(decoded.failure.code);
  return decoded.value;
}

function encodedFrame(
  kind: WorkerProtocolMessageKind,
  id: bigint,
  replyTo: bigint | null,
  payload: Uint8Array,
): Uint8Array {
  const envelope = encodeWorkerProtocolEnvelope({ version: 1, kind, id, replyTo, payload });
  if (!envelope.ok) throw new Error(envelope.failure.code);
  const frame = encodeWorkerProtocolFrame(envelope.value);
  if (!frame.ok) throw new Error(frame.failure.code);
  return frame.value;
}

function connectedPair(
  bridge: RuntimeBridge,
): Readonly<{ process: ProcessRuntimeBridge; server: RuntimeWorkerServer }> {
  const incoming = new AsyncByteQueue();
  const connection: { server?: RuntimeWorkerServer } = {};
  const transport: ProcessWorkerTransport = {
    incoming,
    write: (frame) => {
      if (!connection.server) throw new Error('worker server is not connected');
      return connection.server.receive(frame);
    },
    close: () => connection.server?.finish(),
  };
  const server = new RuntimeWorkerServer({
    bridge,
    write: (frame) => incoming.push(frame),
    close: () => incoming.end(),
  });
  connection.server = server;
  return Object.freeze({ process: new ProcessRuntimeBridge({ transport }), server });
}

class ScriptedTransport implements ProcessWorkerTransport {
  readonly incoming = new AsyncByteQueue();
  readonly sent: WorkerProtocolEnvelope[] = [];
  closes = 0;
  #nextWorkerId = 1n;

  async write(frame: Uint8Array): Promise<void> {
    const envelope = decodeFrame(frame);
    this.sent.push(envelope);
    if (envelope.kind !== 'session.hello') return;
    const negotiated = negotiateWorkerProtocolHandshake(DEFAULT_PROCESS_WORKER_HELLO, DEFAULT_WORKER_HANDSHAKE_SUPPORT);
    if (!negotiated.compatible) throw new Error('test handshake is incompatible');
    const payload = encodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD, negotiated.welcome);
    if (!payload.ok) throw new Error(payload.failure.code);
    this.emit('session.welcome', envelope.id, payload.value);
  }

  close(): void {
    this.closes++;
    this.incoming.end();
  }

  emit(kind: WorkerProtocolMessageKind, replyTo: bigint | null, payload: Uint8Array, id?: bigint): void {
    this.incoming.push(encodedFrame(kind, id ?? this.#nextWorkerId++, replyTo, payload));
  }

  async request(kind: WorkerProtocolMessageKind): Promise<WorkerProtocolEnvelope> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = this.sent.find((envelope) => envelope.kind === kind);
      if (found) return found;
      await Bun.sleep(1);
    }
    throw new Error(`missing ${kind}`);
  }
}

describe('process RuntimeBridge state machine', () => {
  it('correlates every operation and routes worker actions only to the owning execute host', async () => {
    const fake = new FakeBridge();
    const { process } = connectedPair(fake);
    expect(await process.ready()).toBe(true);
    expect(await process.check(checkRequest)).toMatchObject({ status: 'bridge_error' });
    expect(await process.inspect({ ...checkRequest, views: ['semantic_graph'] })).toMatchObject({
      status: 'bridge_error',
    });
    const hostCalls: string[] = [];
    expect(
      await process.execute(
        {
          abiVersion: { major: 2, minor: 0 },
          registry: checkRequest.registry,
          slotId: checkRequest.slotId,
          invocationId: actionRequest.invocationId,
          program: { kind: 'source', source: checkRequest },
          input: [0xf6],
          limits: STANDARD_EXECUTION_LIMITS,
          trace: 'none',
        },
        {
          handleAction: async (request) => {
            hostCalls.push(request.requestId);
            return {
              abiVersion: request.abiVersion,
              requestId: request.requestId,
              result: { tag: 'completed', value: [0xf6] },
            };
          },
        },
      ),
    ).toMatchObject({ status: 'bridge_error' });
    expect(
      await process.cancel({ abiVersion: { major: 2, minor: 0 }, invocationId: actionRequest.invocationId }),
    ).toEqual({ status: 'not_active' });
    expect(await process.close()).toEqual({ status: 'closed' });
    expect(hostCalls).toEqual([actionRequest.requestId]);
    expect(fake.calls).toEqual([
      `check:${checkRequest.slotId}`,
      'inspect:semantic_graph',
      `execute:${actionRequest.invocationId}`,
      `outcome:${actionRequest.requestId}`,
      `cancel:${actionRequest.invocationId}`,
      'close',
    ]);
  });

  it('fails every pending exchange on an unknown correlation without accepting a later reply', async () => {
    const transport = new ScriptedTransport();
    const bridge = new ProcessRuntimeBridge({ transport });
    expect(await bridge.ready()).toBe(true);
    const pendingCheck = bridge.check(checkRequest);
    const pendingInspect = bridge.inspect({ ...checkRequest, views: ['semantic_graph'] });
    await transport.request('bridge.check.request');
    await transport.request('bridge.inspect.request');
    const payload = encodeWorkerBridgePayload('bridge.check.result', {
      status: 'bridge_error',
      error: { code: 'adapter_failure', phase: 'check' },
    });
    if (!payload.ok) throw new Error(payload.failure.code);
    transport.emit('bridge.check.result', 999n, payload.value);
    expect(await pendingCheck).toEqual({
      status: 'bridge_error',
      error: { code: 'adapter_failure', phase: 'check', detail: 'unknown or late worker correlation' },
    });
    expect(await pendingInspect).toEqual({
      status: 'bridge_error',
      error: { code: 'adapter_failure', phase: 'inspect', detail: 'unknown or late worker correlation' },
    });
    expect(transport.closes).toBe(1);
    expect(await bridge.check(checkRequest)).toMatchObject({ status: 'bridge_error' });
  });

  it('fails closed on crossed, duplicate, late, and state-invalid worker messages', async () => {
    for (const fault of ['crossed', 'duplicate', 'late', 'state-invalid'] as const) {
      const transport = new ScriptedTransport();
      const bridge = new ProcessRuntimeBridge({ transport });
      expect(await bridge.ready()).toBe(true);
      if (fault === 'state-invalid') {
        const action = encodeWorkerBridgePayload('action.request', { executeId: 99n, request: actionRequest });
        if (!action.ok) throw new Error(action.failure.code);
        transport.emit('action.request', null, action.value);
      } else {
        const pending = bridge.check(checkRequest);
        const request = await transport.request('bridge.check.request');
        if (fault === 'crossed') {
          const result = encodeWorkerBridgePayload('bridge.inspect.result', {
            status: 'bridge_error',
            error: { code: 'adapter_failure', phase: 'inspect' },
          });
          if (!result.ok) throw new Error(result.failure.code);
          transport.emit('bridge.inspect.result', request.id, result.value);
          await pending;
        } else {
          const result = encodeWorkerBridgePayload('bridge.check.result', {
            status: 'bridge_error',
            error: { code: 'adapter_failure', phase: 'check' },
          });
          if (!result.ok) throw new Error(result.failure.code);
          transport.emit('bridge.check.result', request.id, result.value, 2n);
          await pending;
          if (fault === 'duplicate') {
            const second = bridge.check(checkRequest);
            const secondRequest = await transport.request('bridge.check.request');
            transport.emit('bridge.check.result', secondRequest.id, result.value, 2n);
            await second;
          } else {
            transport.emit('bridge.check.result', request.id, result.value, 3n);
          }
        }
      }
      for (let attempt = 0; attempt < 100 && transport.closes === 0; attempt++) await Bun.sleep(1);
      expect(transport.closes).toBe(1);
      expect(await bridge.check(checkRequest)).toMatchObject({ status: 'bridge_error' });
    }
  });
});
