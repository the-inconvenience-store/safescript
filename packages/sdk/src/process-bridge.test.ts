import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolFrame,
  decodeCanonical,
  derivedActionSiteId,
  derivedSemanticNodeId,
  derivedSemanticRevisionId,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  encodeWorkerProtocolPayload,
  hash,
  ids,
  negotiateWorkerProtocolHandshake,
  resultSchema,
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  STANDARD_SEMANTIC_GRAPH_LIMITS,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  type ActionRequest,
  type CheckRequest,
  type IrDigest,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type SemanticEditId,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
} from '@safescript/contracts';
import {
  DEFAULT_WORKER_HANDSHAKE_SUPPORT,
  decodeWorkerBridgePayload,
  encodeWorkerBridgePayload,
  RuntimeWorkerServer,
} from '@safescript/worker';

import {
  SupervisedProcessRuntimeBridge,
  createNodeProcessRuntimeBridge,
  createSafeScript,
  defineContract,
  type ContractType,
} from './index.js';
import { DEFAULT_PROCESS_WORKER_HELLO, ProcessRuntimeBridge, type ProcessWorkerTransport } from './process-bridge.js';

const digest = '0'.repeat(64);
const gatewayInputType: ContractType<{ readonly value: bigint }> = {
  id: ids.type('type:test.process-gateway.input'),
  schema: { kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] },
};
const gatewayOutputType: ContractType<string> = {
  id: ids.type('type:test.process-gateway.output'),
  schema: { kind: 'string' },
};
const gatewayErrorType: ContractType<string> = {
  id: ids.type('type:test.process-gateway.error'),
  schema: { kind: 'string' },
};
const gatewayOperationId = ids.operation('operation:test.process-gateway.read');
const gatewaySlotId = ids.slot('slot:test.process-gateway.main');
const gatewayContract = defineContract({
  id: ids.contract('contract:test.process-gateway'),
  operations: {
    read: {
      id: gatewayOperationId,
      input: gatewayInputType,
      output: gatewayOutputType,
      error: gatewayErrorType,
      effectCost: 1,
    },
  },
  slots: {
    main: {
      id: gatewaySlotId,
      input: gatewayInputType,
      output: gatewayOutputType,
      operations: [gatewayOperationId],
      compileLimits: { sourceBytes: 1_000 },
      executionLimits: { fuel: 1_000, hostCalls: 1 },
    },
  },
});
type GatewayContext = Readonly<{ actor: string }>;
type GatewayOperations = typeof gatewayContract.operations;
type GatewaySlots = typeof gatewayContract.slots;

function gatewayAction(request: Parameters<RuntimeBridge['execute']>[0]): ActionRequest {
  return {
    contractId: gatewayContract.id,
    irDigest: hash('ir', Uint8Array.of(1)) as unknown as IrDigest,
    invocationId: request.invocationId,
    requestId: ids.request(request.invocationId, 0),
    slotId: gatewaySlotId,
    operationId: gatewayOperationId,
    actionSiteId: derivedActionSiteId(Uint8Array.of(1)),
    source: { module: ids.module('module:test.process-gateway'), start: 0, end: 1 },
    input: request.input,
  };
}
const checkRequest = {
  registry: {
    id: 'contract:test.process-bridge',
    digest,
    schemas: { types: [] },
    operations: [],
    slots: [],
    definitions: [],
  },
  slotId: 'slot:test.process-bridge',
  source: {
    module: 'module:test.process-bridge',
    source: [101, 120],
  },
  limits: STANDARD_COMPILE_LIMITS,
} as unknown as CheckRequest;
const semanticGraphView = {
  kind: 'semantic_graph',
  schema: SEMANTIC_GRAPH_SCHEMA,
  limits: STANDARD_SEMANTIC_GRAPH_LIMITS,
} as const;
const semanticEditRequest = {
  ...checkRequest,
  editSchema: SEMANTIC_EDIT_SCHEMA,
  graphSchema: SEMANTIC_GRAPH_SCHEMA,
  baseRevision: derivedSemanticRevisionId(Uint8Array.of(1)),
  edits: [
    {
      kind: 'rename_symbol',
      editId: 'edit:rename' as SemanticEditId,
      target: derivedSemanticNodeId(Uint8Array.of(2)),
      newName: 'renamed',
      preconditions: [],
    },
  ],
  editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
  views: [],
} as Parameters<RuntimeBridge['applySemanticEdits']>[0];

const actionRequest = {
  contractId: 'contract:test.process-bridge',
  irDigest: digest,
  invocationId: 'invocation:11111111111111111111111111111111',
  requestId: 'request:11111111111111111111111111111111:0',
  slotId: 'slot:test.process-bridge',
  operationId: 'operation:test.process-bridge',
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
    this.calls.push(`inspect:${request.views.map((view) => view.kind).join(',')}`);
    return { status: 'bridge_error' as const, error: { code: 'adapter_failure' as const, phase: 'inspect' as const } };
  }

  async applySemanticEdits(request: Parameters<RuntimeBridge['applySemanticEdits']>[0]) {
    this.calls.push(`edit:${request.edits.map((edit) => edit.kind).join(',')}`);
    return {
      status: 'bridge_error' as const,
      error: { code: 'adapter_failure' as const, phase: 'apply_semantic_edits' as const },
    };
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

class GatewayBridge extends FakeBridge {
  readonly outcomes: Awaited<ReturnType<RuntimeBridgeHost['handleAction']>>[] = [];

  override async execute(request: Parameters<RuntimeBridge['execute']>[0], host: RuntimeBridgeHost) {
    this.calls.push(`execute:${request.invocationId}`);
    this.outcomes.push(await host.handleAction(gatewayAction(request)));
    return { status: 'bridge_error' as const, error: { code: 'adapter_failure' as const, phase: 'execute' as const } };
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

  constructor(readonly hello: typeof DEFAULT_PROCESS_WORKER_HELLO = DEFAULT_PROCESS_WORKER_HELLO) {}

  async write(frame: Uint8Array): Promise<void> {
    const envelope = decodeFrame(frame);
    this.sent.push(envelope);
    if (envelope.kind !== 'session.hello') return;
    const negotiated = negotiateWorkerProtocolHandshake(this.hello, DEFAULT_WORKER_HANDSHAKE_SUPPORT);
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

class WriteFailingTransport extends ScriptedTransport {
  failedWrites = 0;

  override async write(frame: Uint8Array): Promise<void> {
    const envelope = decodeFrame(frame);
    if (envelope.kind === 'bridge.check.request') {
      this.failedWrites++;
      throw new Error('SECRET_ESTABLISHED_WRITE_FAILURE');
    }
    await super.write(frame);
  }
}

class StderrTransport extends ScriptedTransport {
  readonly stderr = new AsyncByteQueue();
}

describe('process RuntimeBridge state machine', () => {
  it('rejects an override outside its digest allow-list before launch', async () => {
    const bridge = createNodeProcessRuntimeBridge({
      override: {
        entryPath: new URL('process-bridge.ts', import.meta.url).pathname,
        nodePath: process.execPath,
        digestAllowlist: ['f'.repeat(64)],
      },
    });

    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_identity_mismatch', phase: 'check' },
    });
    expect(await bridge.inspect({ ...checkRequest, views: [semanticGraphView] })).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_identity_mismatch', phase: 'inspect' },
    });
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('builds and launches the pinned worker artifact without ambient discovery', async () => {
    const workerDirectory = new URL('../../worker/', import.meta.url).pathname;
    const build = Bun.spawn([process.execPath, 'scripts/build.ts'], {
      cwd: workerDirectory,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await build.exited).toBe(0);
    const nodePath = Bun.which('node');
    if (!nodePath) throw new Error('test requires the supported Node runtime');

    const bridge = createNodeProcessRuntimeBridge({ nodePath });
    expect(await bridge.cancel({ invocationId: actionRequest.invocationId })).toEqual({ status: 'not_active' });
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('expires partial frames and retains only the selected stderr tail', async () => {
    const hello = {
      ...DEFAULT_PROCESS_WORKER_HELLO,
      limits: {
        ...DEFAULT_PROCESS_WORKER_HELLO.limits,
        partial_frame_ms: 5n,
        max_stderr_bytes: 4n,
      },
    };
    const transport = new StderrTransport(hello);
    const bridge = new ProcessRuntimeBridge({ transport, hello });
    expect(await bridge.ready()).toBe(true);
    transport.stderr.push(Uint8Array.of(1, 2, 3));
    transport.stderr.push(Uint8Array.of(4, 5, 6));
    for (let attempt = 0; attempt < 100 && bridge.capturedStderr().length !== 4; attempt++) await Bun.sleep(1);
    expect(bridge.capturedStderr()).toEqual(Uint8Array.of(3, 4, 5, 6));

    transport.incoming.push(Uint8Array.of(0));
    for (let attempt = 0; attempt < 100 && !bridge.isFailed(); attempt++) await Bun.sleep(1);
    expect(bridge.isFailed()).toBe(true);
    expect(transport.closes).toBe(1);
  });

  it('reserves negotiated in-flight capacity before queueing data work', async () => {
    const hello = {
      ...DEFAULT_PROCESS_WORKER_HELLO,
      limits: { ...DEFAULT_PROCESS_WORKER_HELLO.limits, max_in_flight: 1n },
    };
    const transport = new ScriptedTransport(hello);
    const bridge = new ProcessRuntimeBridge({ transport, hello });
    expect(await bridge.ready()).toBe(true);

    const pending = bridge.check(checkRequest);
    await transport.request('bridge.check.request');
    expect(await bridge.inspect({ ...checkRequest, views: [semanticGraphView] })).toEqual({
      status: 'bridge_error',
      error: { code: 'capacity_exceeded', phase: 'inspect' },
    });
    expect(transport.sent.filter((envelope) => envelope.kind === 'bridge.check.request')).toHaveLength(1);

    const cancellation = bridge.cancel({
      invocationId: actionRequest.invocationId,
    });
    const cancelRequest = await transport.request('bridge.cancel.request');
    const cancelResult = encodeWorkerBridgePayload('bridge.cancel.result', { status: 'not_active' });
    if (!cancelResult.ok) throw new Error('test cancellation was not encoded');
    transport.emit('bridge.cancel.result', cancelRequest.id, cancelResult.value);
    expect(await cancellation).toEqual({ status: 'not_active' });

    const request = transport.sent.find((envelope) => envelope.kind === 'bridge.check.request');
    const result = encodeWorkerBridgePayload('bridge.check.result', {
      status: 'bridge_error',
      error: { code: 'adapter_failure', phase: 'check' },
    });
    if (!request || !result.ok) throw new Error('test request was not encoded');
    transport.emit('bridge.check.result', request.id, result.value);
    expect(await pending).toMatchObject({ status: 'bridge_error' });
    transport.close();
    expect(await bridge.close()).toMatchObject({ status: 'bridge_error' });
  });

  it('starts lazily, fails lost work once, and permanently fails later calls', async () => {
    const transports: ScriptedTransport[] = [];
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        const transport = new ScriptedTransport();
        transports.push(transport);
        return transport;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    expect(transports).toHaveLength(0);
    const lost = bridge.check(checkRequest);
    while (!transports[0]) await Bun.sleep(1);
    const firstRequest = await transports[0].request('bridge.check.request');
    transports[0].incoming.end();

    expect(await lost).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'check' },
    });
    expect(transports[0].sent.filter(({ kind }) => kind === 'bridge.check.request')).toEqual([firstRequest]);

    expect(await bridge.inspect({ ...checkRequest, views: [semanticGraphView] })).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'inspect' },
    });
    expect(transports).toHaveLength(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('permanently fails after an idle connection is lost', async () => {
    const transport = new ScriptedTransport();
    let starts = 0;
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return transport;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    const first = bridge.check(checkRequest);
    const firstRequest = await transport.request('bridge.check.request');
    const firstPayload = encodeWorkerBridgePayload('bridge.check.result', {
      status: 'bridge_error',
      error: { code: 'invalid_request', phase: 'check' },
    });
    if (!firstPayload.ok) throw new Error(firstPayload.failure.code);
    transport.emit('bridge.check.result', firstRequest.id, firstPayload.value);
    await first;
    transport.incoming.end();
    while (transport.closes === 0) await Bun.sleep(1);

    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'check' },
    });
    expect(starts).toBe(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('retains one terminal startup failure for later operation phases', async () => {
    let starts = 0;
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        throw new Error('SECRET_START_FAILURE');
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_start_failed', phase: 'check' },
    });
    expect(await bridge.inspect({ ...checkRequest, views: [semanticGraphView] })).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_start_failed', phase: 'inspect' },
    });
    expect(starts).toBe(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('bounds one shared lazy startup and closes a transport that arrives late', async () => {
    let starts = 0;
    let resolveStart!: (transport: ProcessWorkerTransport) => void;
    const delayed = new Promise<ProcessWorkerTransport>((resolve) => {
      resolveStart = resolve;
    });
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return delayed;
      },
      startupTimeoutMs: 10,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    const [check, inspect] = await Promise.all([
      bridge.check(checkRequest),
      bridge.inspect({ ...checkRequest, views: [semanticGraphView] }),
    ]);
    expect(check).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_start_timeout', phase: 'check' },
    });
    expect(inspect).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_start_timeout', phase: 'inspect' },
    });
    expect(starts).toBe(1);

    const late = new ScriptedTransport();
    resolveStart(late);
    while (late.closes === 0) await Bun.sleep(1);
    expect(late.closes).toBe(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('does not replay a request whose established worker write is lost', async () => {
    const first = new WriteFailingTransport();
    let starts = 0;
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return first;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'check' },
    });
    expect(first.failedWrites).toBe(1);
    expect(starts).toBe(1);

    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'check' },
    });
    expect(starts).toBe(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('forces one bounded close and cannot restart after explicit close', async () => {
    const transport = new ScriptedTransport();
    let starts = 0;
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return transport;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 10,
    });
    const checking = bridge.check(checkRequest);
    const request = await transport.request('bridge.check.request');
    const payload = encodeWorkerBridgePayload('bridge.check.result', {
      status: 'bridge_error',
      error: { code: 'invalid_request', phase: 'check' },
    });
    if (!payload.ok) throw new Error(payload.failure.code);
    transport.emit('bridge.check.result', request.id, payload.value);
    await checking;

    const firstClose = bridge.close();
    const secondClose = bridge.close();
    expect(secondClose).toBe(firstClose);
    expect(await firstClose).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_close_timeout', phase: 'close' },
    });
    expect(transport.closes).toBe(1);
    expect(await bridge.check(checkRequest)).toEqual({
      status: 'bridge_error',
      error: { code: 'bridge_closed', phase: 'check' },
    });
    expect(starts).toBe(1);
  });

  it('retains the observed action and never resends it after loss during suspension', async () => {
    const transport = new ScriptedTransport();
    let starts = 0;
    let release!: () => void;
    const handlerMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return transport;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });
    const execution = bridge.execute(
      {
        registry: checkRequest.registry,
        slotId: checkRequest.slotId,
        invocationId: actionRequest.invocationId,
        program: { kind: 'source', source: checkRequest },
        input: [0xf6],
        limits: STANDARD_EXECUTION_LIMITS,
        trace: false,
      },
      {
        handleAction: async (request) => {
          observed.push(request.requestId);
          await handlerMayFinish;
          return {
            requestId: request.requestId,
            result: { tag: 'completed', value: [0xf6] },
          };
        },
      },
    );
    const executeRequest = await transport.request('bridge.execute.request');
    const actionPayload = encodeWorkerBridgePayload('action.request', {
      executeId: executeRequest.id,
      request: actionRequest,
    });
    if (!actionPayload.ok) throw new Error(actionPayload.failure.code);
    transport.emit('action.request', null, actionPayload.value);
    while (observed.length === 0) await Bun.sleep(1);
    transport.incoming.end();

    expect(await execution).toEqual({
      status: 'bridge_error',
      error: { code: 'worker_lost', phase: 'execute' },
    });
    expect(observed).toEqual([actionRequest.requestId]);
    release();
    await Bun.sleep(1);
    expect(transport.sent.filter(({ kind }) => kind === 'action.outcome')).toHaveLength(0);
    expect(starts).toBe(1);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('shares lazy readiness and atomically fails all work on one lost connection', async () => {
    const transport = new ScriptedTransport();
    let starts = 0;
    const bridge = new SupervisedProcessRuntimeBridge({
      start: () => {
        starts++;
        return transport;
      },
      startupTimeoutMs: 100,
      handshakeTimeoutMs: 100,
      closeTimeoutMs: 100,
    });

    const check = bridge.check(checkRequest);
    const inspect = bridge.inspect({ ...checkRequest, views: [semanticGraphView] });
    await transport.request('bridge.check.request');
    await transport.request('bridge.inspect.request');
    expect(starts).toBe(1);
    transport.incoming.end();

    expect(await Promise.all([check, inspect])).toEqual([
      { status: 'bridge_error', error: { code: 'worker_lost', phase: 'check' } },
      { status: 'bridge_error', error: { code: 'worker_lost', phase: 'inspect' } },
    ]);
    expect(await bridge.close()).toEqual({ status: 'closed' });
  });

  it('routes a worker action through the validated beforeAction hook', async () => {
    const workerBridge = new GatewayBridge();
    const { process } = connectedPair(workerBridge);
    const order: string[] = [];
    let handlerCalls = 0;
    const invocationId = ids.invocation('invocation:22222222222222222222222222222222');
    const safe = createSafeScript<GatewayContext, GatewayOperations, GatewaySlots>({
      contract: gatewayContract,
      bridge: process,
      handlers: {
        read: () => {
          handlerCalls++;
          return { tag: 'ok', value: 'handled' };
        },
      },
      hooks: {
        beforeAction: ({ input, context }) => {
          order.push(`before:${input.value}:${context.actor}`);
          return { status: 'stop', error: 'denied' };
        },
      },
    });

    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 7n },
      context: { actor: 'sam' },
      invocationId,
    });

    expect(handlerCalls).toBe(0);
    expect(order).toEqual(['before:7:sam']);
    expect(workerBridge.outcomes).toHaveLength(1);
    const outcome = workerBridge.outcomes[0];
    expect(outcome?.result.tag).toBe('completed');
    if (outcome?.result.tag !== 'completed') throw new Error('expected completed declared error');
    expect(
      decodeCanonical(
        resultSchema(gatewayOutputType.schema, gatewayErrorType.schema),
        Uint8Array.from(outcome.result.value),
      ),
    ).toEqual({ ok: true, value: { tag: 'error', value: 'denied' } });
    expect(result.status).toBe('bridge_error');
    expect(await safe.close()).toEqual({ status: 'closed' });
  });

  it('dispatches a worker action once and preserves unknown effect state for a throwing handler', async () => {
    const workerBridge = new GatewayBridge();
    const { process } = connectedPair(workerBridge);
    let handlerCalls = 0;
    const safe = createSafeScript<GatewayContext, GatewayOperations, GatewaySlots>({
      contract: gatewayContract,
      bridge: process,
      handlers: {
        read: () => {
          handlerCalls++;
          throw new Error('SECRET_HANDLER_FAILURE');
        },
      },
      hooks: {
        beforeAction: () => {
          return { status: 'continue' } as const;
        },
      },
    });

    await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 8n },
      context: { actor: 'sam' },
      invocationId: ids.invocation('invocation:33333333333333333333333333333333'),
    });

    expect(handlerCalls).toBe(1);
    expect(workerBridge.outcomes).toMatchObject([
      { result: { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'handler_fault' } } } },
    ]);
    expect(JSON.stringify(workerBridge.outcomes)).not.toContain('SECRET_HANDLER_FAILURE');
    expect(await safe.close()).toEqual({ status: 'closed' });
  });

  it('keeps a correlated but invalid worker action away from SDK policy and handlers', async () => {
    const transport = new ScriptedTransport();
    const process = new ProcessRuntimeBridge({ transport });
    let hookCalls = 0;
    let handlerCalls = 0;
    const invocationId = ids.invocation('invocation:44444444444444444444444444444444');
    const safe = createSafeScript<GatewayContext, GatewayOperations, GatewaySlots>({
      contract: gatewayContract,
      bridge: process,
      handlers: {
        read: () => {
          handlerCalls++;
          return { tag: 'ok', value: 'handled' };
        },
      },
      hooks: {
        beforeAction: () => {
          hookCalls++;
          return { status: 'continue' } as const;
        },
      },
    });

    const execution = safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 9n },
      context: { actor: 'sam' },
      invocationId,
    });
    const executeEnvelope = await transport.request('bridge.execute.request');
    const executeRequest = decodeWorkerBridgePayload('bridge.execute.request', executeEnvelope.payload);
    if (!executeRequest.ok) throw new Error(executeRequest.failure.code);
    const invalidAction = {
      ...gatewayAction(executeRequest.value),
      operationId: ids.operation('operation:test.process-gateway.missing'),
    };
    const actionPayload = encodeWorkerBridgePayload('action.request', {
      executeId: executeEnvelope.id,
      request: invalidAction,
    });
    if (!actionPayload.ok) throw new Error(actionPayload.failure.code);
    transport.emit('action.request', null, actionPayload.value);

    const actionOutcomeEnvelope = await transport.request('action.outcome');
    const actionOutcome = decodeWorkerBridgePayload('action.outcome', actionOutcomeEnvelope.payload);
    expect(actionOutcome).toMatchObject({
      ok: true,
      value: {
        outcome: {
          result: { tag: 'failed', value: { effectState: 'not_performed', failure: { code: 'gateway_fault' } } },
        },
      },
    });
    const executionPayload = encodeWorkerBridgePayload('bridge.execute.result', {
      status: 'bridge_error',
      error: { code: 'adapter_failure', phase: 'execute' },
    });
    if (!executionPayload.ok) throw new Error(executionPayload.failure.code);
    transport.emit('bridge.execute.result', executeEnvelope.id, executionPayload.value);

    expect(await execution).toMatchObject({ status: 'bridge_error' });
    expect(hookCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    transport.close();
    expect(await safe.close()).toMatchObject({ status: 'bridge_error' });
  });

  it('correlates every operation and routes worker actions only to the owning execute host', async () => {
    const fake = new FakeBridge();
    const { process } = connectedPair(fake);
    expect(await process.ready()).toBe(true);
    expect(await process.check(checkRequest)).toMatchObject({ status: 'bridge_error' });
    expect(await process.inspect({ ...checkRequest, views: [semanticGraphView] })).toMatchObject({
      status: 'bridge_error',
    });
    expect(await process.applySemanticEdits(semanticEditRequest)).toMatchObject({ status: 'bridge_error' });
    const hostCalls: string[] = [];
    expect(
      await process.execute(
        {
          registry: checkRequest.registry,
          slotId: checkRequest.slotId,
          invocationId: actionRequest.invocationId,
          program: { kind: 'source', source: checkRequest },
          input: [0xf6],
          limits: STANDARD_EXECUTION_LIMITS,
          trace: false,
        },
        {
          handleAction: async (request) => {
            hostCalls.push(request.requestId);
            return {
              requestId: request.requestId,
              result: { tag: 'completed', value: [0xf6] },
            };
          },
        },
      ),
    ).toMatchObject({ status: 'bridge_error' });
    expect(await process.cancel({ invocationId: actionRequest.invocationId })).toEqual({ status: 'not_active' });
    expect(await process.close()).toEqual({ status: 'closed' });
    expect(hostCalls).toEqual([actionRequest.requestId]);
    expect(fake.calls).toEqual([
      `check:${checkRequest.slotId}`,
      'inspect:semantic_graph',
      'edit:rename_symbol',
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
    const pendingInspect = bridge.inspect({ ...checkRequest, views: [semanticGraphView] });
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
