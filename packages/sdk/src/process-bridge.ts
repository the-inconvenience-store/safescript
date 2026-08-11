import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolPayload,
  SAFESCRIPT_VERSION,
  STANDARD_WORKER_OPERATIONAL_LIMITS,
  validateWorkerProtocolWelcome,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  WorkerProtocolFrameDecoder,
  WorkerProtocolFrameWriter,
  type ActionOutcome,
  type ActionRequest,
  type ApplySemanticEditsRequest,
  type ApplySemanticEditsResult,
  type BridgeError,
  type CancelRequest,
  type CancelResult,
  type CheckRequest,
  type CheckResult,
  type CloseResult,
  type ExecuteRequest,
  type ExecutionResult,
  type InspectRequest,
  type InspectResult,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type WorkerProtocolCodecLimits,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
  type WorkerProtocolOperationalLimits,
  type WorkerProtocolSessionHello,
} from '@safescript/contracts';
import { decodeWorkerBridgePayload, encodeWorkerBridgePayload } from '@safescript/worker';

const MAX_UINT64 = (1n << 64n) - 1n;
const ZERO_DIGEST = '0'.repeat(64);

/** Host-side protocol identity used until release packaging supplies a generated build manifest. */
export const DEFAULT_PROCESS_WORKER_HELLO: WorkerProtocolSessionHello = Object.freeze({
  version: SAFESCRIPT_VERSION,
  sdk_build: 'safescript-sdk-process-bridge',
  expected_worker: Object.freeze({
    version: SAFESCRIPT_VERSION,
    build_digest: ZERO_DIGEST,
    override: false,
  }),
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
});

/** One already-created child-process byte channel. Spawn policy and supervision are layered above this seam. */
export interface ProcessWorkerTransport {
  readonly incoming: AsyncIterable<Uint8Array>;
  /** Optional child stderr stream; the bridge drains it into a bounded private ring. */
  readonly stderr?: AsyncIterable<Uint8Array>;
  write(completeFrame: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface ProcessRuntimeBridgeOptions {
  readonly transport: ProcessWorkerTransport;
  readonly hello?: WorkerProtocolSessionHello;
}

/** Lazy worker creation and terminal lifecycle policy for a supervised process bridge. */
export interface SupervisedProcessRuntimeBridgeOptions {
  readonly start: () => ProcessWorkerTransport | Promise<ProcessWorkerTransport>;
  readonly hello?: WorkerProtocolSessionHello;
  readonly startupTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

type BridgePhase = BridgeError['phase'];
type TerminalKind =
  | 'bridge.check.result'
  | 'bridge.inspect.result'
  | 'bridge.apply_semantic_edits.result'
  | 'bridge.execute.result'
  | 'bridge.cancel.result'
  | 'session.close.result';

interface PendingExchange {
  readonly kind: TerminalKind;
  readonly phase: BridgePhase;
  readonly invocationId?: string;
  readonly host?: RuntimeBridgeHost;
  readonly actionIds: Set<bigint>;
  resolve(value: unknown): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function error(phase: BridgePhase, code: BridgeError['code'], detail?: string): BridgeError {
  return Object.freeze({
    code,
    phase,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 160) }),
  });
}

function failedResult(phase: BridgePhase, code: BridgeError['code'], detail?: string): unknown {
  const bridgeError = error(phase, code, detail);
  if (phase === 'close') return Object.freeze({ status: 'bridge_error', error: bridgeError }) satisfies CloseResult;
  if (phase === 'cancel') return Object.freeze({ status: 'bridge_error', error: bridgeError }) satisfies CancelResult;
  return Object.freeze({ status: 'bridge_error', error: bridgeError });
}

function handlerFailure(request: ActionRequest): ActionOutcome {
  return Object.freeze({
    requestId: request.requestId,
    result: Object.freeze({
      tag: 'failed' as const,
      value: Object.freeze({
        effectState: 'unknown' as const,
        failure: Object.freeze({ code: 'handler_fault' as const }),
      }),
    }),
  });
}

function payloadLimits(limits: WorkerProtocolOperationalLimits): WorkerProtocolCodecLimits {
  return Object.freeze({
    maxBytes: Number(limits.max_payload_bytes),
    maxDepth: Number(limits.max_decoded_depth),
    maxNodes: Number(limits.max_decoded_nodes),
  });
}

function reservedQueueBytes(limits: WorkerProtocolOperationalLimits): number {
  return Math.min(Number(limits.max_frame_bytes), Math.floor(Number(limits.max_queued_bytes) / 2));
}

/**
 * SDK-side protocol adapter for one worker connection.
 *
 * It owns envelope IDs, exact reply correlation, action suspension, and terminal resolution. Child creation,
 * supervision, flow-control ceilings, and host gateway construction remain separate concerns.
 */
export class ProcessRuntimeBridge implements RuntimeBridge {
  readonly #transport: ProcessWorkerTransport;
  readonly #hello: WorkerProtocolSessionHello;
  readonly #decoder: WorkerProtocolFrameDecoder;
  readonly #writer: WorkerProtocolFrameWriter;
  readonly #ready = deferred<boolean>();
  readonly #pending = new Map<bigint, PendingExchange>();
  readonly #seenInbound = new Set<bigint>();
  readonly #seenActionRequests = new Set<string>();
  readonly #activeInvocations = new Map<string, bigint>();
  #state: 'new' | 'handshaking' | 'ready' | 'closing' | 'closed' | 'failed' = 'new';
  #nextId = 1n;
  #helloId: bigint | undefined;
  #closePromise: Promise<CloseResult> | undefined;
  #transportClosed = false;
  #maxInFlight = 0;
  #limits: WorkerProtocolOperationalLimits;
  #partialFrameTimer: ReturnType<typeof setTimeout> | undefined;
  #stderr = new Uint8Array();

  constructor(options: ProcessRuntimeBridgeOptions) {
    if (
      !options?.transport ||
      typeof options.transport.write !== 'function' ||
      typeof options.transport.close !== 'function'
    )
      throw new TypeError('process worker transport is required');
    this.#transport = options.transport;
    this.#hello = options.hello ?? DEFAULT_PROCESS_WORKER_HELLO;
    this.#limits = this.#hello.limits;
    this.#decoder = new WorkerProtocolFrameDecoder({ maxFrameBytes: Number(this.#hello.limits.max_frame_bytes) });
    this.#writer = new WorkerProtocolFrameWriter((frame) => this.#transport.write(frame), {
      maxFrameBytes: Number(this.#hello.limits.max_frame_bytes),
      maxQueuedBytes: Number(this.#hello.limits.max_queued_bytes),
      reservedQueuedBytes: reservedQueueBytes(this.#hello.limits),
    });
    void this.#start();
    void this.#read();
    if (this.#transport.stderr) void this.#readStderr(this.#transport.stderr);
  }

  /** Resolves only after a validated welcome, returning false for every failed or incompatible handshake. */
  ready(): Promise<boolean> {
    return this.#ready.promise;
  }

  /** Reports whether this one connection has entered an unrecoverable failed state. */
  isFailed(): boolean {
    return this.#state === 'failed';
  }

  /** Returns the bounded operator-only stderr tail; it is never inserted into protocol failures or semantic facts. */
  capturedStderr(): Uint8Array {
    return this.#stderr.slice();
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    if (!(await this.#available())) return failedResult('check', this.#closedCode()) as CheckResult;
    return this.#request('bridge.check.request', 'bridge.check.result', 'check', request) as Promise<CheckResult>;
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    if (!(await this.#available())) return failedResult('inspect', this.#closedCode()) as InspectResult;
    return this.#request(
      'bridge.inspect.request',
      'bridge.inspect.result',
      'inspect',
      request,
    ) as Promise<InspectResult>;
  }

  async applySemanticEdits(request: ApplySemanticEditsRequest): Promise<ApplySemanticEditsResult> {
    if (!(await this.#available()))
      return failedResult('apply_semantic_edits', this.#closedCode()) as ApplySemanticEditsResult;
    return this.#request(
      'bridge.apply_semantic_edits.request',
      'bridge.apply_semantic_edits.result',
      'apply_semantic_edits',
      request,
    ) as Promise<ApplySemanticEditsResult>;
  }

  async execute(request: ExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (!(await this.#available())) return failedResult('execute', this.#closedCode()) as ExecutionResult;
    if (this.#activeInvocations.has(request.invocationId))
      return Object.freeze({
        status: 'not_started',
        error: error('execute', 'invalid_request', 'duplicate active invocation'),
      });
    return this.#request('bridge.execute.request', 'bridge.execute.result', 'execute', request, {
      invocationId: request.invocationId,
      host,
    }) as Promise<ExecutionResult>;
  }

  async cancel(request: CancelRequest): Promise<CancelResult> {
    if (!(await this.#available())) return failedResult('cancel', this.#closedCode()) as CancelResult;
    return this.#request('bridge.cancel.request', 'bridge.cancel.result', 'cancel', request) as Promise<CancelResult>;
  }

  close(): Promise<CloseResult> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  /** Forces this connection to fail; used by a supervisor after an operational deadline expires. */
  terminate(): Promise<void> {
    return this.#fail('worker connection terminated by supervisor', 'worker_lost');
  }

  async #close(): Promise<CloseResult> {
    if (this.#state === 'closed') return { status: 'closed' };
    if (!(await this.#ready.promise) || this.#state !== 'ready') {
      await this.#closeTransport();
      return failedResult('close', this.#closedCode()) as CloseResult;
    }
    this.#state = 'closing';
    const result = (await this.#request(
      'session.close.request',
      'session.close.result',
      'close',
      Object.freeze({}),
      undefined,
      true,
    )) as CloseResult;
    if (result.status === 'closed') this.#state = 'closed';
    await this.#closeTransport();
    return result;
  }

  async #available(): Promise<boolean> {
    return (await this.#ready.promise) && this.#state === 'ready';
  }

  #closedCode(): BridgeError['code'] {
    return this.#state === 'closed' || this.#state === 'closing' ? 'bridge_closed' : 'adapter_failure';
  }

  async #start(): Promise<void> {
    try {
      this.#state = 'handshaking';
      const payload = encodeWorkerProtocolPayload(
        WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
        this.#hello,
        payloadLimits(this.#limits),
      );
      if (!payload.ok) return this.#fail('invalid session hello');
      this.#helloId = this.#allocateId();
      await this.#sendWithId(this.#helloId, 'session.hello', null, payload.value);
    } catch {
      await this.#fail('worker handshake write failed');
    }
  }

  async #request(
    requestKind:
      | 'bridge.check.request'
      | 'bridge.inspect.request'
      | 'bridge.apply_semantic_edits.request'
      | 'bridge.execute.request'
      | 'bridge.cancel.request'
      | 'session.close.request',
    resultKind: TerminalKind,
    phase: BridgePhase,
    value: unknown,
    execution?: Readonly<{ invocationId: string; host: RuntimeBridgeHost }>,
    allowClosing = false,
  ): Promise<unknown> {
    if (this.#state !== 'ready' && !(allowClosing && this.#state === 'closing'))
      return failedResult(phase, this.#closedCode());
    const dataRequest =
      requestKind === 'bridge.check.request' ||
      requestKind === 'bridge.inspect.request' ||
      requestKind === 'bridge.apply_semantic_edits.request' ||
      requestKind === 'bridge.execute.request';
    if (dataRequest && this.#dataInFlight() >= this.#maxInFlight) return failedResult(phase, 'capacity_exceeded');
    if (requestKind === 'bridge.cancel.request' && this.#pending.size >= Number(this.#limits.max_pending_replies))
      return failedResult(phase, 'capacity_exceeded');
    const encoded = encodeWorkerBridgePayload(requestKind, value as never, payloadLimits(this.#limits));
    if (!encoded.ok) return failedResult(phase, 'invalid_request', encoded.failure.detail ?? encoded.failure.code);
    const id = this.#allocateId();
    const result = new Promise<unknown>((resolve) => {
      this.#pending.set(id, {
        kind: resultKind,
        phase,
        ...(execution === undefined ? {} : { invocationId: execution.invocationId, host: execution.host }),
        actionIds: new Set(),
        resolve,
      });
    });
    if (execution) this.#activeInvocations.set(execution.invocationId, id);
    try {
      await this.#sendWithId(id, requestKind, null, encoded.value);
    } catch {
      await this.#fail('worker request write failed', 'worker_lost');
    }
    return result;
  }

  async #read(): Promise<void> {
    try {
      for await (const chunk of this.#transport.incoming) {
        if (this.#state === 'closed' || this.#state === 'failed') break;
        const frames = this.#decoder.push(chunk);
        if (!frames.ok) return this.#fail(frames.failure.code);
        this.#refreshPartialFrameDeadline();
        for (const bytes of frames.value) {
          const envelope = decodeWorkerProtocolEnvelope(bytes, {
            envelopeLimits: { ...payloadLimits(this.#limits), maxBytes: Number(this.#limits.max_frame_bytes) },
            payloadLimits: payloadLimits(this.#limits),
          });
          if (!envelope.ok) return this.#fail(envelope.failure.code);
          await this.#accept(envelope.value);
          if (this.#failed()) return;
        }
      }
      const finished = this.#decoder.finish();
      this.#clearPartialFrameDeadline();
      if (!finished.ok) return this.#fail(finished.failure.code);
      if (this.#state !== 'closed') await this.#fail('worker transport ended', 'worker_lost');
    } catch {
      await this.#fail('worker transport failed', 'worker_lost');
    }
  }

  async #accept(envelope: WorkerProtocolEnvelope): Promise<void> {
    if (this.#seenInbound.has(envelope.id)) return this.#fail('duplicate worker message id');
    this.#seenInbound.add(envelope.id);
    if (this.#state === 'handshaking') {
      await this.#acceptHandshake(envelope);
      return;
    }
    if (envelope.kind === 'action.request') {
      this.#acceptAction(envelope);
      return;
    }
    if (envelope.replyTo === null) return this.#fail('unexpected worker initiating message');
    const pending = this.#pending.get(envelope.replyTo);
    if (!pending) return this.#fail('unknown or late worker correlation');
    if (pending.kind === 'bridge.execute.result' && pending.actionIds.size !== 0)
      return this.#fail('execute completed with unresolved actions');
    if (envelope.kind === 'protocol.error') {
      const decoded = decodeWorkerBridgePayload('protocol.error', envelope.payload, payloadLimits(this.#limits));
      if (!decoded.ok) return this.#fail('invalid protocol error payload');
      this.#finish(envelope.replyTo, pending, failedResult(pending.phase, 'adapter_failure', decoded.value.code));
      return;
    }
    if (envelope.kind !== pending.kind) return this.#fail('crossed worker correlation');
    if (pending.kind === 'session.close.result' && this.#pending.size !== 1)
      return this.#fail('close completed before worker quiescence');
    const decoded = this.#decodeTerminal(pending.kind, envelope.payload);
    if (!decoded.ok) return this.#fail(decoded.detail);
    this.#finish(envelope.replyTo, pending, decoded.value);
    if (pending.kind === 'session.close.result' && (decoded.value as CloseResult).status === 'closed')
      this.#state = 'closed';
  }

  async #acceptHandshake(envelope: WorkerProtocolEnvelope): Promise<void> {
    if (envelope.replyTo !== this.#helloId) return this.#fail('invalid handshake correlation');
    if (envelope.kind === 'session.incompatible') {
      const decoded = decodeWorkerProtocolPayload(
        WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
        envelope.payload,
        payloadLimits(this.#limits),
      );
      if (!decoded.ok) return this.#fail('invalid incompatibility payload');
      return this.#fail('incompatible worker session');
    }
    if (envelope.kind !== 'session.welcome') return this.#fail('unexpected handshake response');
    const decoded = decodeWorkerProtocolPayload(
      WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
      envelope.payload,
      payloadLimits(this.#limits),
    );
    if (!decoded.ok || !validateWorkerProtocolWelcome(this.#hello, decoded.value))
      return this.#fail('invalid worker welcome');
    this.#maxInFlight = Number(decoded.value.limits.max_in_flight);
    this.#limits = decoded.value.limits;
    const queue = this.#writer.configureQueue(Number(this.#limits.max_queued_bytes), reservedQueueBytes(this.#limits));
    if (!queue.ok) return this.#fail('invalid negotiated queue limits');
    this.#stderr = this.#stderr.slice(Math.max(0, this.#stderr.length - Number(this.#limits.max_stderr_bytes)));
    this.#state = 'ready';
    this.#ready.resolve(true);
  }

  #acceptAction(envelope: WorkerProtocolEnvelope): void {
    if ((this.#state !== 'ready' && this.#state !== 'closing') || envelope.replyTo !== null) {
      void this.#fail('state-invalid action request');
      return;
    }
    const decoded = decodeWorkerBridgePayload('action.request', envelope.payload, payloadLimits(this.#limits));
    if (!decoded.ok) {
      void this.#fail('invalid action request payload');
      return;
    }
    const execute = this.#pending.get(decoded.value.executeId);
    if (
      !execute ||
      execute.kind !== 'bridge.execute.result' ||
      !execute.host ||
      execute.invocationId !== decoded.value.request.invocationId ||
      this.#seenActionRequests.has(decoded.value.request.requestId) ||
      this.#actionInFlight() >= this.#maxInFlight
    ) {
      void this.#fail('invalid action correlation');
      return;
    }
    this.#seenActionRequests.add(decoded.value.request.requestId);
    execute.actionIds.add(envelope.id);
    void this.#resolveAction(envelope.id, decoded.value.executeId, decoded.value.request, execute, execute.host);
  }

  async #resolveAction(
    envelopeId: bigint,
    executeId: bigint,
    request: ActionRequest,
    exchange: PendingExchange,
    host: RuntimeBridgeHost,
  ): Promise<void> {
    let outcome: ActionOutcome;
    try {
      outcome = await host.handleAction(request);
    } catch {
      outcome = handlerFailure(request);
    }
    if (
      !exchange.actionIds.has(envelopeId) ||
      this.#pending.get(executeId) !== exchange ||
      outcome.requestId !== request.requestId
    ) {
      await this.#fail('late or mismatched action outcome');
      return;
    }
    const encoded = encodeWorkerBridgePayload(
      'action.outcome',
      { request: envelopeId, outcome },
      payloadLimits(this.#limits),
    );
    if (!encoded.ok) return this.#fail('invalid host action outcome');
    exchange.actionIds.delete(envelopeId);
    try {
      await this.#send('action.outcome', envelopeId, encoded.value);
    } catch {
      await this.#fail('action outcome write failed', 'worker_lost');
    }
  }

  #decodeTerminal(
    kind: TerminalKind,
    payload: Uint8Array,
  ): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; detail: string }> {
    const decoded =
      kind === 'bridge.check.result'
        ? decodeWorkerBridgePayload('bridge.check.result', payload, payloadLimits(this.#limits))
        : kind === 'bridge.inspect.result'
          ? decodeWorkerBridgePayload('bridge.inspect.result', payload, payloadLimits(this.#limits))
          : kind === 'bridge.apply_semantic_edits.result'
            ? decodeWorkerBridgePayload('bridge.apply_semantic_edits.result', payload, payloadLimits(this.#limits))
            : kind === 'bridge.execute.result'
              ? decodeWorkerBridgePayload('bridge.execute.result', payload, payloadLimits(this.#limits))
              : kind === 'bridge.cancel.result'
                ? decodeWorkerBridgePayload('bridge.cancel.result', payload, payloadLimits(this.#limits))
                : decodeWorkerBridgePayload('session.close.result', payload, payloadLimits(this.#limits));
    return decoded.ok
      ? Object.freeze({ ok: true, value: decoded.value })
      : Object.freeze({ ok: false, detail: decoded.failure.detail ?? decoded.failure.code });
  }

  #finish(id: bigint, pending: PendingExchange, value: unknown): void {
    this.#pending.delete(id);
    if (pending.invocationId !== undefined) this.#activeInvocations.delete(pending.invocationId);
    pending.resolve(value);
  }

  #dataInFlight(): number {
    let count = 0;
    for (const pending of this.#pending.values())
      if (
        pending.kind === 'bridge.check.result' ||
        pending.kind === 'bridge.inspect.result' ||
        pending.kind === 'bridge.apply_semantic_edits.result' ||
        pending.kind === 'bridge.execute.result'
      )
        count++;
    return count;
  }

  #actionInFlight(): number {
    let count = 0;
    for (const pending of this.#pending.values()) count += pending.actionIds.size;
    return count;
  }

  async #send(kind: WorkerProtocolMessageKind, replyTo: bigint | null, payload: Uint8Array): Promise<void> {
    await this.#sendWithId(this.#allocateId(), kind, replyTo, payload);
  }

  async #sendWithId(
    id: bigint,
    kind: WorkerProtocolMessageKind,
    replyTo: bigint | null,
    payload: Uint8Array,
  ): Promise<void> {
    const envelope = encodeWorkerProtocolEnvelope(
      { version: 1, kind, id, replyTo, payload },
      {
        envelopeLimits: { ...payloadLimits(this.#limits), maxBytes: Number(this.#limits.max_frame_bytes) },
        payloadLimits: payloadLimits(this.#limits),
      },
    );
    if (!envelope.ok) throw new Error('invalid process bridge envelope');
    const reserved =
      kind === 'session.hello' ||
      kind === 'session.close.request' ||
      kind === 'bridge.cancel.request' ||
      kind === 'action.outcome';
    const written = await this.#writer.write(envelope.value, { reserved });
    if (!written.ok) throw new Error('invalid process bridge frame');
  }

  #allocateId(): bigint {
    if (this.#nextId > MAX_UINT64) throw new Error('process bridge message id exhausted');
    return this.#nextId++;
  }

  #failed(): boolean {
    return this.#state === 'failed';
  }

  #refreshPartialFrameDeadline(): void {
    this.#clearPartialFrameDeadline();
    if (!this.#decoder.hasPartialFrame()) return;
    this.#partialFrameTimer = setTimeout(() => {
      const expired = this.#decoder.expirePartialFrame();
      if (!expired.ok) void this.#fail(expired.failure.code);
    }, Number(this.#limits.partial_frame_ms));
  }

  #clearPartialFrameDeadline(): void {
    if (this.#partialFrameTimer === undefined) return;
    clearTimeout(this.#partialFrameTimer);
    this.#partialFrameTimer = undefined;
  }

  async #readStderr(stderr: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stderr) {
        const maximum = Number(this.#limits.max_stderr_bytes);
        const owned = chunk.slice(Math.max(0, chunk.length - maximum));
        const retained = this.#stderr.slice(Math.max(0, this.#stderr.length + owned.length - maximum));
        const next = new Uint8Array(retained.length + owned.length);
        next.set(retained);
        next.set(owned, retained.length);
        this.#stderr = next;
      }
    } catch {
      // Stderr is operational context only; a broken diagnostic stream cannot alter protocol or semantic results.
    }
  }

  async #fail(detail: string, code: BridgeError['code'] = 'adapter_failure'): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#state = 'failed';
    this.#clearPartialFrameDeadline();
    this.#ready.resolve(false);
    for (const [id, pending] of this.#pending)
      this.#finish(id, pending, failedResult(pending.phase, code, code === 'worker_lost' ? undefined : detail));
    await this.#closeTransport();
  }

  async #closeTransport(): Promise<void> {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    try {
      await this.#transport.close();
    } catch {
      // Transport close is best effort after all public promises already have bounded terminal results.
    }
  }
}

interface SupervisedConnection {
  readonly bridge: ProcessRuntimeBridge;
  readonly transport: ProcessWorkerTransport;
}

type DeadlineResult<T> =
  | Readonly<{ status: 'completed'; value: T }>
  | Readonly<{ status: 'failed'; error: unknown }>
  | Readonly<{ status: 'timeout' }>;

export class WorkerStartError extends Error {
  constructor(readonly code: Extract<BridgeError['code'], 'worker_start_failed' | 'worker_identity_mismatch'>) {
    super(code);
    this.name = 'WorkerStartError';
  }
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timeout' });
    }, milliseconds);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'completed', value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'failed', error });
      },
    );
  });
}

type Acquisition =
  Readonly<{ ok: true; connection: SupervisedConnection }> | Readonly<{ ok: false; code: BridgeError['code'] }>;

/**
 * Lazy owner for one terminal process bridge connection.
 *
 * Each public request is submitted to exactly one connection. Startup failure or worker loss permanently fails this
 * facade; the supervisor never restarts, retries, or replays accepted work.
 */
export class SupervisedProcessRuntimeBridge implements RuntimeBridge {
  readonly #options: Readonly<{
    start: SupervisedProcessRuntimeBridgeOptions['start'];
    hello: WorkerProtocolSessionHello;
    startupTimeoutMs: number;
    handshakeTimeoutMs: number;
    closeTimeoutMs: number;
  }>;
  #connection: SupervisedConnection | undefined;
  #starting: Promise<Acquisition> | undefined;
  #failure: BridgeError['code'] | undefined;
  #closed = false;
  #closePromise: Promise<CloseResult> | undefined;

  constructor(options: SupervisedProcessRuntimeBridgeOptions) {
    if (!options || typeof options.start !== 'function') throw new TypeError('worker start function is required');
    const hello = options.hello ?? DEFAULT_PROCESS_WORKER_HELLO;
    const values = {
      startupTimeoutMs: options.startupTimeoutMs ?? Number(hello.limits.worker_start_ms),
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? Number(hello.limits.handshake_ms),
      closeTimeoutMs: options.closeTimeoutMs ?? Number(hello.limits.graceful_close_ms),
    };
    if (
      ![values.startupTimeoutMs, values.handshakeTimeoutMs, values.closeTimeoutMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new TypeError('worker supervisor limits are invalid');
    this.#options = { ...values, start: options.start, hello };
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    const acquired = await this.#acquire();
    if (!acquired.ok) return failedResult('check', acquired.code) as CheckResult;
    const result = await acquired.connection.bridge.check(request);
    this.#observe(acquired.connection, result);
    return result;
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    const acquired = await this.#acquire();
    if (!acquired.ok) return failedResult('inspect', acquired.code) as InspectResult;
    const result = await acquired.connection.bridge.inspect(request);
    this.#observe(acquired.connection, result);
    return result;
  }

  async applySemanticEdits(request: ApplySemanticEditsRequest): Promise<ApplySemanticEditsResult> {
    const acquired = await this.#acquire();
    if (!acquired.ok) return failedResult('apply_semantic_edits', acquired.code) as ApplySemanticEditsResult;
    const result = await acquired.connection.bridge.applySemanticEdits(request);
    this.#observe(acquired.connection, result);
    return result;
  }

  async execute(request: ExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult> {
    const acquired = await this.#acquire();
    if (!acquired.ok) return failedResult('execute', acquired.code) as ExecutionResult;
    const result = await acquired.connection.bridge.execute(request, host);
    this.#observe(acquired.connection, result);
    return result;
  }

  async cancel(request: CancelRequest): Promise<CancelResult> {
    const acquired = await this.#acquire();
    if (!acquired.ok) return failedResult('cancel', acquired.code) as CancelResult;
    const result = await acquired.connection.bridge.cancel(request);
    this.#observe(acquired.connection, result);
    return result;
  }

  close(): Promise<CloseResult> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<CloseResult> {
    const starting = this.#starting;
    if (starting) await withDeadline(starting, this.#options.closeTimeoutMs);
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return Object.freeze({ status: 'closed' });
    const closed = await withDeadline(connection.bridge.close(), this.#options.closeTimeoutMs);
    if (closed.status === 'completed') return closed.value;
    await connection.bridge.terminate();
    return failedResult('close', closed.status === 'timeout' ? 'worker_close_timeout' : 'worker_lost') as CloseResult;
  }

  async #acquire(): Promise<Acquisition> {
    if (this.#closed) return Object.freeze({ ok: false, code: 'bridge_closed' });
    if (this.#failure) return Object.freeze({ ok: false, code: this.#failure });
    if (this.#connection?.bridge.isFailed()) {
      this.#connection = undefined;
      return this.#terminal('worker_lost');
    }
    if (this.#connection) return Object.freeze({ ok: true, connection: this.#connection });
    if (this.#starting) return this.#starting;
    const starting = this.#start();
    this.#starting = starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async #start(): Promise<Acquisition> {
    const spawning = Promise.resolve().then(this.#options.start);
    const spawned = await withDeadline(spawning, this.#options.startupTimeoutMs);
    if (spawned.status === 'timeout') {
      void spawning.then(
        (transport) => this.#closeTransport(transport),
        () => undefined,
      );
      return this.#terminal('worker_start_timeout');
    }
    if (spawned.status === 'failed')
      return this.#terminal(spawned.error instanceof WorkerStartError ? spawned.error.code : 'worker_start_failed');
    const transport = spawned.value;
    let bridge: ProcessRuntimeBridge;
    try {
      bridge = new ProcessRuntimeBridge({ transport, hello: this.#options.hello });
    } catch {
      await this.#closeTransport(transport);
      return this.#terminal('worker_start_failed');
    }
    const ready = await withDeadline(bridge.ready(), this.#options.handshakeTimeoutMs);
    if (ready.status === 'timeout') {
      await bridge.terminate();
      return this.#terminal('worker_start_timeout');
    }
    if (ready.status === 'failed') {
      await bridge.terminate();
      return this.#terminal('worker_start_failed');
    }
    if (!ready.value) return this.#terminal('worker_start_failed');
    if (this.#closed) {
      await bridge.terminate();
      return Object.freeze({ ok: false, code: 'bridge_closed' });
    }
    const connection = Object.freeze({ bridge, transport });
    this.#connection = connection;
    return Object.freeze({ ok: true, connection });
  }

  #observe(connection: SupervisedConnection, result: unknown): void {
    const lost =
      this.#connection === connection &&
      (connection.bridge.isFailed() ||
        (result !== null &&
          typeof result === 'object' &&
          'status' in result &&
          result.status === 'bridge_error' &&
          'error' in result &&
          result.error !== null &&
          typeof result.error === 'object' &&
          'code' in result.error &&
          result.error.code === 'worker_lost'));
    if (lost) {
      this.#connection = undefined;
      this.#failure ??= 'worker_lost';
    }
  }

  #terminal(code: BridgeError['code']): Acquisition {
    this.#failure ??= code;
    return Object.freeze({ ok: false, code: this.#failure });
  }

  async #closeTransport(transport: ProcessWorkerTransport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Forced supervisor shutdown is best effort after public work has a bounded terminal result.
    }
  }
}
