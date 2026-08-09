import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolFrame,
  encodeWorkerProtocolFrame,
  WorkerProtocolFrameDecoder,
  WorkerProtocolFrameWriter,
  type WorkerProtocolFailureCode,
} from './index.js';

const bytes = (hex: string): Uint8Array => Uint8Array.fromHex(hex);
const hex = (value: Uint8Array): string => value.toHex();

const envelope = bytes(
  'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
);
const frame = bytes(
  '0000003da562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
);

describe('worker protocol stdio framing', () => {
  it('matches the normative four-byte big-endian frame', () => {
    expect(encodeWorkerProtocolFrame(envelope)).toEqual({ ok: true, value: frame });
    expect(decodeWorkerProtocolFrame(frame)).toEqual({ ok: true, value: envelope });
  });

  it('publishes framing failures in the stable worker-protocol catalog', () => {
    const expected = [
      'frame_length_zero',
      'frame_too_large',
      'truncated_frame',
      'frame_timeout',
    ] satisfies readonly WorkerProtocolFailureCode[];
    expect(expected).toHaveLength(4);
  });

  it('decodes frames split at every byte boundary and coalesced in one chunk', () => {
    const split = new WorkerProtocolFrameDecoder();
    for (let index = 0; index < frame.length; index++) {
      const result = split.push(frame.subarray(index, index + 1));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(index === frame.length - 1 ? [envelope] : []);
    }
    expect(split.finish()).toEqual({ ok: true, value: [] });

    const coalesced = new WorkerProtocolFrameDecoder();
    const chunk = new Uint8Array(frame.length * 2);
    chunk.set(frame);
    chunk.set(frame, frame.length);
    expect(coalesced.push(chunk)).toEqual({ ok: true, value: [envelope, envelope] });
    expect(coalesced.finish()).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['zero length', '00000000', 'frame_length_zero'],
    ['above the absolute maximum', '01000001', 'frame_too_large'],
    ['truncated header', '000000', 'truncated_frame'],
    ['truncated body', '00000002a0', 'truncated_frame'],
    ['trailing bytes', '00000001a000', 'truncated_frame'],
  ] as const)('rejects a single frame with %s', (_name, input, code) => {
    const result = decodeWorkerProtocolFrame(bytes(input));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe(code satisfies WorkerProtocolFailureCode);
  });

  it('validates a declared length before allocating or accepting body bytes', () => {
    const decoder = new WorkerProtocolFrameDecoder({ maxFrameBytes: 60 });
    const result = decoder.push(bytes('0000003d'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('frame_too_large');
    expect(decoder.push(envelope)).toEqual(result);
  });

  it('fails EOF and expiry for partial frames without losing completed boundaries', () => {
    const partialHeader = new WorkerProtocolFrameDecoder();
    expect(partialHeader.push(bytes('00')).ok).toBe(true);
    const headerEof = partialHeader.finish();
    expect(headerEof.ok).toBe(false);
    if (!headerEof.ok) expect(headerEof.failure.code).toBe('truncated_frame');

    const partialBody = new WorkerProtocolFrameDecoder();
    expect(partialBody.push(bytes('00000002a0')).ok).toBe(true);
    const bodyEof = partialBody.finish();
    expect(bodyEof.ok).toBe(false);
    if (!bodyEof.ok) expect(bodyEof.failure.code).toBe('truncated_frame');

    const trailingPartial = new WorkerProtocolFrameDecoder();
    const first = new Uint8Array(frame.length + 1);
    first.set(frame);
    expect(trailingPartial.push(first)).toEqual({ ok: true, value: [envelope] });
    expect(trailingPartial.finish().ok).toBe(false);

    const expired = new WorkerProtocolFrameDecoder();
    expect(expired.push(bytes('00000002a0')).ok).toBe(true);
    const timeout = expired.expirePartialFrame();
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.failure.code).toBe('frame_timeout');
  });

  it('serializes concurrent writes as complete immutable frames', async () => {
    const output: number[] = [];
    const writer = new WorkerProtocolFrameWriter(async (completeFrame) => {
      for (const byte of completeFrame) {
        output.push(byte);
        await Promise.resolve();
      }
    });
    const first = bytes('a0');
    const writes = Promise.all([writer.write(first), writer.write(bytes('a1616101'))]);
    first[0] = 0xff;
    expect(await writes).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(hex(Uint8Array.from(output))).toBe('00000001a000000004a1616101');
  });

  it('bounds queued bytes and gives reserved terminal writes the next fair slot', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const output: string[] = [];
    let writes = 0;
    const writer = new WorkerProtocolFrameWriter(
      async (completeFrame) => {
        const decoded = decodeWorkerProtocolFrame(completeFrame);
        if (!decoded.ok) throw new Error(decoded.failure.code);
        output.push(hex(decoded.value));
        if (writes++ === 0) await blocked;
      },
      { maxFrameBytes: 8, maxQueuedBytes: 4, reservedQueuedBytes: 2 },
    );

    const first = writer.write(bytes('a0a0'));
    const waitingData = writer.write(bytes('a1a1'));
    const terminal = writer.write(bytes('a2a2'), { reserved: true });
    await Promise.resolve();
    expect(output).toEqual(['a0a0']);
    release();

    expect(await Promise.all([first, waitingData, terminal])).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(output).toEqual(['a0a0', 'a2a2', 'a1a1']);
  });
});
