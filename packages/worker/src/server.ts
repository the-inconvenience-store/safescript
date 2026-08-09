import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolPayload,
  negotiateWorkerProtocolHandshake,
  STANDARD_WORKER_OPERATIONAL_LIMITS,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  WorkerProtocolFrameDecoder,
  WorkerProtocolFrameWriter,
  type ActionOutcome,
  type ActionRequest,
  type RuntimeBridge,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
  type WorkerProtocolSessionHello,
  type WorkerProtocolSessionWelcome,
  type WorkerProtocolHandshakeSupport,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';

import { decodeWorkerBridgePayload, encodeWorkerBridgePayload, type WorkerProtocolErrorPayload } from './protocol.js';

const MAX_UINT64 = (1n << 64n) - 1n;
const ZERO_DIGEST = '0'.repeat(64);

export const DEFAULT_WORKER_HANDSHAKE_SUPPORT: WorkerProtocolHandshakeSupport = Object.freeze({
  protocol: Object.freeze({ major: 1n, min_minor: 0n, max_minor: 0n }),
  features: Object.freeze([]),
  worker: Object.freeze({
    package_version: Object.freeze({ major: 1n, minor: 0n, patch: 0n }),
    compiler: Object.freeze({
      version: Object.freeze({ major: 0n, minor: 2n, patch: 0n }),
      build: 'typed-ir-language-1-1',
    }),
    build_digest: ZERO_DIGEST,
  }),
  versions: Object.freeze({
    abi: Object.freeze([Object.freeze({ major: 1n, minor: 0n })]),
    language: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
    ir: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
    diagnostic_catalog: Object.freeze([Object.freeze({ major: 1n, minor: 0n, patch: 0n })]),
    artifact: Object.freeze([Object.freeze({ major: 1n, minor: 0n })]),
    authoring_bundle: Object.freeze([Object.freeze({ major: 1n, minor: 0n, patch: 0n })]),
  }),
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
  implementation: 'safescript-js-worker',
});

export interface RuntimeWorkerServerOptions {
  readonly write: (completeFrame: Uint8Array) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
  readonly bridge?: RuntimeBridge;
  readonly handshake?: WorkerProtocolHandshakeSupport;
}

type ConnectionState = 'new' | 'ready' | 'closing' | 'closed' | 'failed';

interface PendingAction {
  readonly executeId: bigint;
  readonly requestId: string;
  readonly resolve: (outcome: ActionOutcome) => void;
  readonly reject: (error: Error) => void;
}

function boundedDetail(value: string): string {
  return value.slice(0, 160);
}

/**
 * Stateful protocol 1.0 worker endpoint. It owns no ambient handlers or credentials and can be embedded over any
 * ordered byte-stream sink; the executable adapter below binds it to stdin/stdout.
 */
export class RuntimeWorkerServer {
  readonly #bridge: RuntimeBridge;
  readonly #support: WorkerProtocolHandshakeSupport;
  readonly #decoder: WorkerProtocolFrameDecoder;
  readonly #writer: WorkerProtocolFrameWriter;
  readonly #closeTransport: (() => void | Promise<void>) | undefined;
  readonly #seenInbound = new Set<bigint>();
  readonly #pendingActions = new Map<bigint, PendingAction>();
  readonly #tasks = new Set<Promise<void>>();
  #state: ConnectionState = 'new';
  #nextOutboundId = 1n;
  #welcome: WorkerProtocolSessionWelcome | undefined;
  #receiving: Promise<void> = Promise.resolve();

  constructor(options: RuntimeWorkerServerOptions) {
    if (!options || typeof options.write !== 'function') throw new TypeError('worker frame sink is required');
    this.#bridge = options.bridge ?? createDirectRuntimeBridge();
    this.#support = options.handshake ?? DEFAULT_WORKER_HANDSHAKE_SUPPORT;
    this.#closeTransport = options.close;
    const frameMaximum = Number(this.#support.limits.max_frame_bytes);
    this.#decoder = new WorkerProtocolFrameDecoder({ maxFrameBytes: frameMaximum });
    this.#writer = new WorkerProtocolFrameWriter(options.write, { maxFrameBytes: frameMaximum });
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Accepts arbitrary stdin chunks while retaining whole-frame ordering and bounded decode state. */
  receive(chunk: Uint8Array): Promise<void> {
    const owned = chunk.slice();
    const receive = this.#receiving.then(() => this.#receive(owned)).catch(() => this.#fail());
    this.#receiving = receive;
    return receive;
  }

  /** Marks input EOF. A partial frame is a fatal connection failure. */
  async finish(): Promise<void> {
    await this.#receiving;
    if (this.#state === 'closed' || this.#state === 'failed') return;
    const finished = this.#decoder.finish();
    if (!finished.ok) await this.#fail();
    else await this.#fail();
  }

  /** Expires the active partial-frame deadline without exposing timers to the protocol core. */
  async expirePartialFrame(): Promise<void> {
    const expired = this.#decoder.expirePartialFrame();
    if (!expired.ok) await this.#fail();
  }

  /** Waits until every currently accepted bridge operation has produced its terminal frame. */
  async drain(): Promise<void> {
    await this.#receiving;
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  async #receive(chunk: Uint8Array): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    const decoded = this.#decoder.push(chunk);
    if (!decoded.ok) {
      await this.#fail();
      return;
    }
    for (const frame of decoded.value) {
      if (this.#terminal()) break;
      const envelope = decodeWorkerProtocolEnvelope(frame);
      if (!envelope.ok) {
        await this.#fail();
        break;
      }
      if (this.#seenInbound.has(envelope.value.id)) {
        await this.#fail();
        break;
      }
      this.#seenInbound.add(envelope.value.id);
      if (this.#state === 'new' || envelope.value.kind === 'action.outcome') {
        await this.#dispatch(envelope.value);
        continue;
      }
      if (envelope.value.kind === 'session.close.request') {
        if (this.#state !== 'ready' || envelope.value.replyTo !== null) {
          await this.#fail();
          break;
        }
        this.#state = 'closing';
      }
      const task = this.#dispatch(envelope.value).catch(() => this.#fail());
      this.#tasks.add(task);
      void task.finally(() => this.#tasks.delete(task));
    }
  }

  async #dispatch(envelope: WorkerProtocolEnvelope): Promise<void> {
    if (this.#state === 'new') {
      await this.#handshake(envelope);
      return;
    }
    if (envelope.kind === 'action.outcome') {
      this.#acceptActionOutcome(envelope);
      return;
    }
    const closingRequest = envelope.kind === 'session.close.request' && this.#state === 'closing';
    if (envelope.replyTo !== null || (this.#state !== 'ready' && !closingRequest)) {
      await this.#fail();
      return;
    }
    if (envelope.kind === 'bridge.check.request') {
      const request = decodeWorkerBridgePayload('bridge.check.request', envelope.payload);
      if (!request.ok) return this.#requestError(envelope, request.failure.detail ?? request.failure.code);
      await this.#reply(envelope, 'bridge.check.result', await this.#bridge.check(request.value));
      return;
    }
    if (envelope.kind === 'bridge.inspect.request') {
      const request = decodeWorkerBridgePayload('bridge.inspect.request', envelope.payload);
      if (!request.ok) return this.#requestError(envelope, request.failure.detail ?? request.failure.code);
      await this.#reply(envelope, 'bridge.inspect.result', await this.#bridge.inspect(request.value));
      return;
    }
    if (envelope.kind === 'bridge.execute.request') {
      const request = decodeWorkerBridgePayload('bridge.execute.request', envelope.payload);
      if (!request.ok) return this.#requestError(envelope, request.failure.detail ?? request.failure.code);
      const result = await this.#bridge.execute(request.value, {
        handleAction: (action) => this.#requestAction(envelope.id, action),
      });
      await this.#reply(envelope, 'bridge.execute.result', result);
      return;
    }
    if (envelope.kind === 'bridge.cancel.request') {
      const request = decodeWorkerBridgePayload('bridge.cancel.request', envelope.payload);
      if (!request.ok) return this.#requestError(envelope, request.failure.detail ?? request.failure.code);
      await this.#reply(envelope, 'bridge.cancel.result', await this.#bridge.cancel(request.value));
      return;
    }
    if (envelope.kind === 'session.close.request') {
      const request = decodeWorkerBridgePayload('session.close.request', envelope.payload);
      if (!request.ok) return this.#requestError(envelope, request.failure.detail ?? request.failure.code);
      const result = await this.#bridge.close();
      await this.#reply(envelope, 'session.close.result', result);
      this.#state = 'closed';
      await this.#closeTransport?.();
      return;
    }
    await this.#fail();
  }

  async #handshake(envelope: WorkerProtocolEnvelope): Promise<void> {
    if (envelope.kind !== 'session.hello' || envelope.replyTo !== null) {
      await this.#fail();
      return;
    }
    const hello = decodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, envelope.payload);
    if (!hello.ok) {
      await this.#requestError(envelope, hello.failure.detail ?? hello.failure.code);
      await this.#fail();
      return;
    }
    const negotiated = negotiateWorkerProtocolHandshake(hello.value as WorkerProtocolSessionHello, this.#support);
    if (!negotiated.compatible) {
      const payload = encodeWorkerProtocolPayload(
        WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
        negotiated.incompatible,
      );
      if (!payload.ok) return this.#fail();
      await this.#send('session.incompatible', envelope.id, payload.value);
      this.#state = 'closed';
      await this.#closeTransport?.();
      return;
    }
    this.#welcome = negotiated.welcome;
    const payload = encodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD, negotiated.welcome);
    if (!payload.ok) return this.#fail();
    await this.#send('session.welcome', envelope.id, payload.value);
    this.#state = 'ready';
  }

  async #requestAction(executeId: bigint, request: ActionRequest): Promise<ActionOutcome> {
    if (this.#state !== 'ready') throw new Error('worker connection is not ready');
    const id = this.#allocateId();
    const encoded = encodeWorkerBridgePayload('action.request', { executeId, request });
    if (!encoded.ok) throw new Error('action request is not protocol encodable');
    const outcome = new Promise<ActionOutcome>((resolve, reject) => {
      this.#pendingActions.set(id, { executeId, requestId: request.requestId, resolve, reject });
    });
    try {
      await this.#sendWithId(id, 'action.request', null, encoded.value);
    } catch (error) {
      this.#pendingActions.delete(id);
      throw error;
    }
    return outcome;
  }

  #acceptActionOutcome(envelope: WorkerProtocolEnvelope): void {
    if ((this.#state !== 'ready' && this.#state !== 'closing') || envelope.replyTo === null)
      throw new Error('invalid action outcome state');
    const pending = this.#pendingActions.get(envelope.replyTo);
    if (!pending) throw new Error('unknown action outcome correlation');
    const decoded = decodeWorkerBridgePayload('action.outcome', envelope.payload);
    if (
      !decoded.ok ||
      decoded.value.request !== envelope.replyTo ||
      decoded.value.outcome.requestId !== pending.requestId
    )
      throw new Error('invalid action outcome payload correlation');
    this.#pendingActions.delete(envelope.replyTo);
    pending.resolve(decoded.value.outcome);
  }

  async #requestError(envelope: WorkerProtocolEnvelope, detail: string): Promise<void> {
    const error: WorkerProtocolErrorPayload = {
      code: 'payload_schema',
      scope: 'request',
      detail: boundedDetail(detail),
    };
    await this.#reply(envelope, 'protocol.error', error);
  }

  async #reply<
    K extends
      | 'bridge.check.result'
      | 'bridge.inspect.result'
      | 'bridge.execute.result'
      | 'bridge.cancel.result'
      | 'session.close.result'
      | 'protocol.error',
  >(
    request: WorkerProtocolEnvelope,
    kind: K,
    value: K extends 'protocol.error'
      ? WorkerProtocolErrorPayload
      : K extends 'bridge.check.result'
        ? Awaited<ReturnType<RuntimeBridge['check']>>
        : K extends 'bridge.inspect.result'
          ? Awaited<ReturnType<RuntimeBridge['inspect']>>
          : K extends 'bridge.execute.result'
            ? Awaited<ReturnType<RuntimeBridge['execute']>>
            : K extends 'bridge.cancel.result'
              ? Awaited<ReturnType<RuntimeBridge['cancel']>>
              : Awaited<ReturnType<RuntimeBridge['close']>>,
  ): Promise<void> {
    const encoded = encodeWorkerBridgePayload(kind, value as never);
    if (!encoded.ok) throw new Error('worker result is not protocol encodable');
    await this.#send(kind, request.id, encoded.value);
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
    const encoded = encodeWorkerProtocolEnvelope({ version: 1, kind, id, replyTo, payload });
    if (!encoded.ok) throw new Error('worker envelope is not protocol encodable');
    const maximum = this.#welcome?.limits.max_frame_bytes ?? this.#support.limits.max_frame_bytes;
    if (BigInt(encoded.value.length) > maximum) throw new Error('worker envelope exceeds negotiated limit');
    const written = await this.#writer.write(encoded.value);
    if (!written.ok) throw new Error('worker frame is not protocol encodable');
  }

  #allocateId(): bigint {
    if (this.#nextOutboundId > MAX_UINT64) throw new Error('worker message id exhausted');
    return this.#nextOutboundId++;
  }

  #terminal(): boolean {
    return this.#state === 'closed' || this.#state === 'failed';
  }

  async #fail(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#state = 'failed';
    for (const pending of this.#pendingActions.values()) pending.reject(new Error('worker protocol connection failed'));
    this.#pendingActions.clear();
    void this.#bridge.close();
    await this.#closeTransport?.();
  }
}
