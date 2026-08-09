import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolPayload,
  defineWorkerProtocolPayload,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolPayload,
  WORKER_PROTOCOL_FAILURE_CODES,
  type WorkerProtocolEnvelope,
  type WorkerProtocolFailureCode,
} from './index.js';

const bytes = (hex: string): Uint8Array => Uint8Array.fromHex(hex);
const hex = (value: Uint8Array): string => value.toHex();

const closePayload = defineWorkerProtocolPayload('session.close.request', {
  kind: 'record',
  fields: [],
});

describe('worker protocol deterministic CBOR', () => {
  it('matches the normative session close request bytes', () => {
    const payload = encodeWorkerProtocolPayload(closePayload, {});
    expect(payload).toEqual({ ok: true, value: bytes('a0') });
    if (!payload.ok) return;

    const encoded = encodeWorkerProtocolEnvelope({
      version: 1,
      kind: closePayload.kind,
      id: 1n,
      replyTo: null,
      payload: payload.value,
    });
    expect(encoded).toEqual({
      ok: true,
      value: bytes(
        'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      ),
    });
    if (!encoded.ok) return;

    expect(decodeWorkerProtocolEnvelope(encoded.value)).toEqual({
      ok: true,
      value: {
        version: 1,
        kind: 'session.close.request',
        id: 1n,
        replyTo: null,
        payload: bytes('a0'),
      },
    });
    expect(decodeWorkerProtocolPayload(closePayload, payload.value)).toEqual({ ok: true, value: {} });
  });

  it.each([
    [
      'non-minimal message ID',
      'a56269641801646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      'noncanonical_cbor',
    ],
    [
      'indefinite payload bytes',
      'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f61645f41a0ff6776657273696f6e01687265706c795f746ff6',
      'noncanonical_cbor',
    ],
    [
      'out-of-order envelope keys',
      'a56776657273696f6e0162696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a0687265706c795f746ff6',
      'noncanonical_cbor',
    ],
    [
      'duplicate envelope field',
      'a66269640162696402646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      'noncanonical_cbor',
    ],
    [
      'unknown envelope field',
      'a66178f662696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      'envelope_schema',
    ],
    [
      'missing envelope field',
      'a462696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01',
      'envelope_schema',
    ],
    [
      'trailing envelope byte',
      'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff600',
      'malformed_cbor',
    ],
    [
      'invalid UTF-8 kind',
      'a562696401646b696e6461ff677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      'malformed_cbor',
    ],
    [
      'forbidden payload tag',
      'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616442c0a06776657273696f6e01687265706c795f746ff6',
      'noncanonical_cbor',
    ],
  ] as const)('rejects the hostile %s fixture', (_name, input, code) => {
    const result = decodeWorkerProtocolEnvelope(bytes(input));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe(code satisfies WorkerProtocolFailureCode);
  });

  it('distinguishes an unsupported envelope version from a malformed envelope', () => {
    const result = decodeWorkerProtocolEnvelope(
      bytes(
        'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e02687265706c795f746ff6',
      ),
    );
    expect(result).toEqual({
      ok: false,
      failure: { code: 'unsupported_envelope_version', path: ['version'] },
    });
  });

  it('refuses to encode an unsupported envelope version', () => {
    const result = encodeWorkerProtocolEnvelope({
      version: 2,
      kind: 'session.close.request',
      id: 1n,
      replyTo: null,
      payload: bytes('a0'),
    } as unknown as WorkerProtocolEnvelope);
    expect(result).toEqual({
      ok: false,
      failure: { code: 'unsupported_envelope_version', path: ['version'] },
    });
  });

  it('publishes the stable codec failure-code catalog', () => {
    expect(WORKER_PROTOCOL_FAILURE_CODES).toEqual([
      'malformed_cbor',
      'noncanonical_cbor',
      'envelope_schema',
      'payload_schema',
      'protocol_limit_exceeded',
      'unsupported_envelope_version',
      'unknown_message_kind',
    ]);
    expect(Object.isFrozen(WORKER_PROTOCOL_FAILURE_CODES)).toBe(true);
  });

  it('allows one immutable schema node to be reused by multiple fields', () => {
    const identifier = { kind: 'text', maxBytes: 32 } as const;
    expect(() =>
      defineWorkerProtocolPayload('protocol.error', {
        kind: 'record',
        fields: [
          { name: 'code', schema: identifier },
          { name: 'scope', schema: identifier },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a canonical envelope whose message kind is not published', () => {
    const result = decodeWorkerProtocolEnvelope(
      bytes(
        'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657378677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      ),
    );
    expect(result).toEqual({
      ok: false,
      failure: { code: 'unknown_message_kind', path: ['kind'] },
    });
  });

  it('enforces closed payload schemas in both directions', () => {
    const payload = defineWorkerProtocolPayload('protocol.error', {
      kind: 'record',
      fields: [
        { name: 'code', schema: { kind: 'literal', value: 'payload_schema' } },
        { name: 'scope', schema: { kind: 'literal', value: 'request' } },
        { name: 'detail', schema: { kind: 'text', maxBytes: 8 }, optional: true },
      ],
    });

    const encoded = encodeWorkerProtocolPayload(payload, {
      code: 'payload_schema',
      scope: 'request',
      detail: 'bounded',
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeWorkerProtocolPayload(payload, encoded.value)).toEqual({
      ok: true,
      value: { code: 'payload_schema', scope: 'request', detail: 'bounded' },
    });

    for (const value of [
      { code: 'payload_schema', scope: 'request', extra: true },
      { code: 'payload_schema' },
      { code: 'payload_schema', scope: 'request', detail: 'too large' },
    ]) {
      const result = encodeWorkerProtocolPayload(payload, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('payload_schema');
    }

    for (const input of ['a0', 'a1656578747261f5']) {
      const result = decodeWorkerProtocolPayload(payload, bytes(input));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('payload_schema');
    }
  });

  it('bounds bytes, depth, and nodes before returning decoded payloads', () => {
    const nested = defineWorkerProtocolPayload('protocol.error', {
      kind: 'array',
      item: { kind: 'array', item: { kind: 'uint' } },
    });
    const wide = defineWorkerProtocolPayload('protocol.error', {
      kind: 'array',
      item: { kind: 'uint' },
    });

    for (const [contract, input, limits] of [
      [nested, '818101', { maxBytes: 16, maxDepth: 1, maxNodes: 8 }],
      [wide, '83010203', { maxBytes: 16, maxDepth: 4, maxNodes: 3 }],
      [wide, '8101', { maxBytes: 1, maxDepth: 4, maxNodes: 8 }],
    ] as const) {
      const result = decodeWorkerProtocolPayload(contract, bytes(input), limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('protocol_limit_exceeded');
    }
  });

  it('counts a literal as its single encoded CBOR node', () => {
    const literal = defineWorkerProtocolPayload('protocol.error', {
      kind: 'literal',
      value: 'closed',
    });
    expect(
      encodeWorkerProtocolPayload(literal, 'closed', {
        maxBytes: 16,
        maxDepth: 1,
        maxNodes: 1,
      }),
    ).toEqual({ ok: true, value: bytes('66636c6f736564') });
  });

  it('normalizes negative zero in a declared float64 choice', () => {
    const float = defineWorkerProtocolPayload('protocol.error', {
      kind: 'oneOf',
      choices: [{ kind: 'float64' }, { kind: 'unit' }],
    });
    expect(encodeWorkerProtocolPayload(float, -0)).toEqual({
      ok: true,
      value: bytes('fb0000000000000000'),
    });
    expect(decodeWorkerProtocolPayload(float, bytes('fb8000000000000000'))).toEqual({
      ok: false,
      failure: {
        code: 'noncanonical_cbor',
        path: [],
        byteOffset: 0,
        detail: 'invalid canonical float64',
      },
    });
  });

  it('distinguishes reserved CBOR syntax from a well-formed alternate spelling', () => {
    const integer = defineWorkerProtocolPayload('protocol.error', { kind: 'uint' });
    expect(decodeWorkerProtocolPayload(integer, bytes('1c'))).toEqual({
      ok: false,
      failure: {
        code: 'malformed_cbor',
        path: [],
        byteOffset: 0,
        detail: 'reserved CBOR additional information',
      },
    });
    for (const input of ['fc', 'ff', 'f8', 'f900']) {
      const result = decodeWorkerProtocolPayload(integer, bytes(input));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('malformed_cbor');
    }
  });

  it('never exposes rejected values through bounded failure detail', () => {
    const secret = 'SUPER_SECRET_PROTOCOL_VALUE';
    const result = encodeWorkerProtocolPayload(closePayload, { secret });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.detail?.length ?? 0).toBeLessThanOrEqual(160);
      expect(JSON.stringify(result.failure)).not.toContain(secret);
    }
  });

  it('encodes byte strings independently from arrays', () => {
    const payload = defineWorkerProtocolPayload('protocol.error', {
      kind: 'record',
      fields: [
        { name: 'bytes', schema: { kind: 'bytes' } },
        { name: 'items', schema: { kind: 'array', item: { kind: 'uint' } } },
      ],
    });
    const result = encodeWorkerProtocolPayload(payload, { bytes: bytes('0102'), items: [1n, 2n] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(hex(result.value)).toBe('a2656279746573420102656974656d73820102');
  });
});
