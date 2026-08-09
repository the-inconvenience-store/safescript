import type { WorkerProtocolCodecFailure, WorkerProtocolCodecResult } from './worker-protocol.js';

/** Immutable protocol 1.0 ceiling for one envelope carried by a frame. */
export const ABSOLUTE_WORKER_FRAME_BYTES = 16 * 1024 * 1024;

/** Standard local-worker deadline for a partially received frame. */
export const STANDARD_WORKER_PARTIAL_FRAME_TIMEOUT_MS = 10_000;

export interface WorkerProtocolFrameOptions {
  readonly maxFrameBytes?: number;
}

const EMPTY_PATH: readonly never[] = Object.freeze([]);

function failure(code: WorkerProtocolCodecFailure['code'], detail: string): WorkerProtocolCodecResult<never> {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ code, path: EMPTY_PATH, detail }),
  });
}

function success<T>(value: T): WorkerProtocolCodecResult<T> {
  return Object.freeze({ ok: true, value });
}

function activeMaximum(options?: WorkerProtocolFrameOptions): WorkerProtocolCodecResult<number> {
  const maximum = options?.maxFrameBytes ?? ABSOLUTE_WORKER_FRAME_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ABSOLUTE_WORKER_FRAME_BYTES)
    return failure('protocol_limit_exceeded', 'invalid maxFrameBytes');
  return Object.freeze({ ok: true, value: maximum });
}

function declaredLength(frame: Uint8Array): number {
  return (
    (frame[0] as number) * 0x100_0000 +
    (frame[1] as number) * 0x1_0000 +
    (frame[2] as number) * 0x100 +
    (frame[3] as number)
  );
}

/** Copies one envelope into its exact protocol 1.0 length-prefixed frame. */
export function encodeWorkerProtocolFrame(
  envelope: Uint8Array,
  options?: WorkerProtocolFrameOptions,
): WorkerProtocolCodecResult<Uint8Array> {
  const maximum = activeMaximum(options);
  if (!maximum.ok) return maximum;
  if (!(envelope instanceof Uint8Array)) return failure('malformed_cbor', 'envelope must be Uint8Array');
  if (envelope.length === 0) return failure('frame_length_zero', 'frame length is zero');
  if (envelope.length > maximum.value) return failure('frame_too_large', 'frame length exceeds active maximum');
  const frame = new Uint8Array(4 + envelope.length);
  new DataView(frame.buffer).setUint32(0, envelope.length);
  frame.set(envelope, 4);
  return Object.freeze({ ok: true, value: frame });
}

/** Decodes exactly one complete frame; concatenated or partial streams use the incremental decoder. */
export function decodeWorkerProtocolFrame(
  frame: Uint8Array,
  options?: WorkerProtocolFrameOptions,
): WorkerProtocolCodecResult<Uint8Array> {
  const maximum = activeMaximum(options);
  if (!maximum.ok) return maximum;
  if (!(frame instanceof Uint8Array)) return failure('truncated_frame', 'frame must be Uint8Array');
  if (frame.length < 4) return failure('truncated_frame', 'frame header is truncated');
  const length = declaredLength(frame);
  if (length === 0) return failure('frame_length_zero', 'frame length is zero');
  if (length > maximum.value) return failure('frame_too_large', 'frame length exceeds active maximum');
  if (frame.length < length + 4) return failure('truncated_frame', 'frame body is truncated');
  if (frame.length > length + 4) return failure('truncated_frame', 'frame has trailing bytes');
  return Object.freeze({ ok: true, value: frame.slice(4) });
}

/** Incrementally separates arbitrary stream chunks into independently owned envelope bytes. */
export class WorkerProtocolFrameDecoder {
  readonly #maximum: WorkerProtocolCodecResult<number>;
  readonly #header = new Uint8Array(4);
  #headerBytes = 0;
  #body: Uint8Array | undefined;
  #bodyBytes = 0;
  #terminal: WorkerProtocolCodecResult<never> | undefined;
  #finished = false;

  constructor(options?: WorkerProtocolFrameOptions) {
    this.#maximum = activeMaximum(options);
  }

  /** Accepts the next stream chunk and returns only frames completed by this call. */
  push(chunk: Uint8Array): WorkerProtocolCodecResult<readonly Uint8Array[]> {
    if (!this.#maximum.ok) return this.#maximum;
    if (this.#terminal) return this.#terminal;
    if (this.#finished) return failure('truncated_frame', 'frame decoder is already finished');
    if (!(chunk instanceof Uint8Array)) return this.#stop('truncated_frame', 'stream chunk must be Uint8Array');

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.#body) {
        const count = Math.min(4 - this.#headerBytes, chunk.length - offset);
        this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes);
        this.#headerBytes += count;
        offset += count;
        if (this.#headerBytes < 4) continue;

        const length = declaredLength(this.#header);
        if (length === 0) return this.#stop('frame_length_zero', 'frame length is zero');
        if (length > this.#maximum.value) return this.#stop('frame_too_large', 'frame length exceeds active maximum');
        this.#body = new Uint8Array(length);
        this.#bodyBytes = 0;
      }

      const count = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
      this.#body.set(chunk.subarray(offset, offset + count), this.#bodyBytes);
      this.#bodyBytes += count;
      offset += count;
      if (this.#bodyBytes === this.#body.length) {
        frames.push(this.#body);
        this.#body = undefined;
        this.#bodyBytes = 0;
        this.#headerBytes = 0;
      }
    }
    return success(Object.freeze(frames));
  }

  /** Marks clean EOF, or fails if any header or body remains partial. */
  finish(): WorkerProtocolCodecResult<readonly Uint8Array[]> {
    if (!this.#maximum.ok) return this.#maximum;
    if (this.#terminal) return this.#terminal;
    if (this.#finished) return success(Object.freeze([]));
    this.#finished = true;
    if (this.#headerBytes !== 0 || this.#body)
      return this.#stop('truncated_frame', this.#body ? 'frame body is truncated' : 'frame header is truncated');
    return success(Object.freeze([]));
  }

  /** Fails the connection only when a partial-frame deadline expires with buffered bytes. */
  expirePartialFrame(): WorkerProtocolCodecResult<undefined> {
    if (!this.#maximum.ok) return this.#maximum;
    if (this.#terminal) return this.#terminal;
    if (this.#headerBytes === 0 && !this.#body) return success(undefined);
    return this.#stop('frame_timeout', 'partial frame deadline expired');
  }

  #stop(code: WorkerProtocolCodecFailure['code'], detail: string): WorkerProtocolCodecResult<never> {
    this.#terminal = failure(code, detail);
    this.#body = undefined;
    this.#bodyBytes = 0;
    this.#headerBytes = 0;
    return this.#terminal;
  }
}

/** One protocol-only byte sink; callers adapt child stdin or worker stdout to this boundary. */
export type WorkerProtocolFrameSink = (completeFrame: Uint8Array) => void | Promise<void>;

/** Serializes complete copied frames so concurrent callers can never interleave stream bytes. */
export class WorkerProtocolFrameWriter {
  readonly #sink: WorkerProtocolFrameSink;
  readonly #options: WorkerProtocolFrameOptions | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(sink: WorkerProtocolFrameSink, options?: WorkerProtocolFrameOptions) {
    if (typeof sink !== 'function') throw new TypeError('worker protocol frame sink must be a function');
    this.#sink = sink;
    this.#options = options;
  }

  /** Copies and queues one envelope immediately, resolving after the complete frame is written. */
  write(envelope: Uint8Array): Promise<WorkerProtocolCodecResult<undefined>> {
    const encoded = encodeWorkerProtocolFrame(envelope, this.#options);
    if (!encoded.ok) return Promise.resolve(encoded);
    const write = this.#tail.then(() => this.#sink(encoded.value));
    this.#tail = write;
    return write.then(() => success(undefined));
  }
}
