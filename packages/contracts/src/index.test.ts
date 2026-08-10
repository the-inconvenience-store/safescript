import { describe, expect, it } from 'bun:test';

import {
  COMPILER_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CATALOG,
  EXECUTION_ERROR_CODES,
  HOST_FAILURE_CODES,
  JSON_VALUE_REGISTRY,
  JSON_VALUE_TYPE,
  MAX_FAILURE_DETAIL_LENGTH,
  MAX_FAILURE_PATH_SEGMENTS,
  canonicalJson,
  canonicalize,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  isActionOutcome,
  optionSchema,
  resultSchema,
  type ContractFailureCode,
  type Schema,
  type TypeDefinition,
} from './index.js';

describe('action outcome validation', () => {
  it('accepts only the current closed action outcome shape', () => {
    const invocationId = ids.invocation('invocation:0123456789abcdef0123456789abcdef');
    const requestId = ids.request(invocationId, 0);
    expect(
      isActionOutcome({
        requestId,
        result: { tag: 'completed', value: [0x82, 0x62, 0x6f, 0x6b, 0xf6] },
      }),
    ).toBe(true);
    expect(
      isActionOutcome({
        requestId,
        result: { tag: 'rejected', value: { code: 'denied' } },
      }),
    ).toBe(false);
  });
});

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const encodedHex = (schema: Schema, value: unknown): string => {
  const result = encodeCanonical(schema, value);
  if (!result.ok) throw new Error(result.failure.code);
  return hex(result.value);
};

describe('deterministic CBOR profile', () => {
  it('has stable scalar and positional fixture vectors', () => {
    expect(encodedHex({ kind: 'unit' }, null)).toBe('f6');
    expect(encodedHex({ kind: 'boolean' }, true)).toBe('f5');
    expect(encodedHex({ kind: 'int64' }, -(1n << 63n))).toBe('3b7fffffffffffffff');
    expect(encodedHex({ kind: 'float64' }, 1.5)).toBe('fb3ff8000000000000');
    expect(encodedHex({ kind: 'string' }, '😀')).toBe('64f09f9880');
    expect(encodedHex({ kind: 'bytes' }, [0, 255])).toBe('4200ff');
    expect(encodedHex({ kind: 'instant' }, { epochSeconds: 0n, nanoseconds: 1 })).toBe('820001');
    expect(
      encodedHex(
        {
          kind: 'record',
          fields: [
            { name: 'name', schema: { kind: 'string' } },
            { name: 'count', schema: { kind: 'int64' } },
          ],
        },
        { count: 1n, name: 'x' },
      ),
    ).toBe('82617801');
    expect(encodedHex(optionSchema({ kind: 'int64' }), { tag: 'some', value: 1n })).toBe('8264736f6d6501');
    expect(encodedHex({ kind: 'tuple', items: [{ kind: 'boolean' }, { kind: 'string' }] }, [false, 'x'])).toBe(
      '82f46178',
    );
  });

  it('round-trips immutable schema-directed values', () => {
    const schema: Schema = {
      kind: 'record',
      fields: [
        { name: 'choice', schema: resultSchema({ kind: 'string' }, { kind: 'int64' }) },
        { name: 'payload', schema: { kind: 'bytes', maxBytes: 4 } },
      ],
    };
    const result = canonicalize(schema, { payload: [1, 2], choice: { tag: 'ok', value: 'yes' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ choice: { tag: 'ok', value: 'yes' }, payload: [1, 2] });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen((result.value as { payload: readonly number[] }).payload)).toBe(true);
  });

  it('rejects every alternate or malformed representative before use', () => {
    const failures: readonly [Schema, Uint8Array, ContractFailureCode][] = [
      [{ kind: 'int64' }, Uint8Array.of(0x18, 0x00), 'noncanonical_cbor'],
      [{ kind: 'int64' }, Uint8Array.of(0x00, 0x00), 'trailing_bytes'],
      [{ kind: 'string' }, Uint8Array.of(0x61, 0x80), 'malformed_cbor'],
      [{ kind: 'float64' }, Uint8Array.of(0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0), 'noncanonical_cbor'],
      [{ kind: 'float64' }, Uint8Array.of(0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0), 'noncanonical_cbor'],
      [{ kind: 'list', item: { kind: 'unit' } }, Uint8Array.of(0x9f, 0xff), 'malformed_cbor'],
      [{ kind: 'tuple', items: [] }, Uint8Array.of(0x81, 0xf6), 'schema_mismatch'],
      [{ kind: 'record', fields: [] }, Uint8Array.of(0xa0), 'schema_mismatch'],
      [{ kind: 'string', maxBytes: 1 }, Uint8Array.of(0x62, 0x61, 0x62), 'limit_exceeded'],
    ];
    for (const [schema, bytes, code] of failures) {
      const result = decodeCanonical(schema, bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe(code);
    }
    expect(encodeCanonical({ kind: 'string' }, '\ud800').ok).toBe(false);
    expect(encodeCanonical({ kind: 'record', fields: [] }, { surprise: true }).ok).toBe(false);
    let getterRan = false;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterRan = true;
        return 1n;
      },
    });
    expect(
      encodeCanonical({ kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] }, accessor).ok,
    ).toBe(false);
    expect(getterRan).toBe(false);
  });
});

describe('recursive schemas and JSON', () => {
  it('accepts finite named recursion and rejects recursion without an inhabitant', () => {
    const tree = ids.type('type:test.tree');
    const fingerprint = hash('type', Uint8Array.of(1));
    const definition: TypeDefinition = {
      id: tree,
      fingerprint,
      schema: {
        kind: 'variant',
        variants: [
          { tag: 'leaf', schema: { kind: 'unit' } },
          { tag: 'branch', schema: { kind: 'list', item: { kind: 'ref', type: tree }, maxItems: 1 } },
        ],
      },
    };
    const registry = defineSchemaRegistry([definition]);
    let value: unknown = { tag: 'leaf', value: null };
    for (let index = 0; index < 20; index++) value = { tag: 'branch', value: [value] };
    expect(encodeCanonical({ kind: 'ref', type: tree }, value, { registry }).ok).toBe(true);
    expect(
      encodeCanonical({ kind: 'ref', type: tree }, value, {
        registry,
        limits: { maxBytes: 4096, maxDepth: 8, maxNodes: 100 },
      }).ok,
    ).toBe(false);

    const impossible = ids.type('type:test.impossible');
    expect(() =>
      defineSchemaRegistry([
        {
          id: impossible,
          fingerprint,
          schema: { kind: 'record', fields: [{ name: 'next', schema: { kind: 'ref', type: impossible } }] },
        },
      ]),
    ).toThrow('no finite inhabitant');
  });

  it('uses the accepted sorted tagged JsonValue representation', () => {
    const result = canonicalJson({ z: null, a: [true, -0] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      tag: 'object',
      value: [
        [
          'a',
          {
            tag: 'array',
            value: [
              { tag: 'boolean', value: true },
              { tag: 'number', value: 0 },
            ],
          },
        ],
        ['z', { tag: 'null', value: null }],
      ],
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(
      encodeCanonical({ kind: 'ref', type: JSON_VALUE_TYPE }, result.value, { registry: JSON_VALUE_REGISTRY }).ok,
    ).toBe(true);
    expect(
      encodeCanonical(
        { kind: 'ref', type: JSON_VALUE_TYPE },
        {
          tag: 'object',
          value: [
            ['z', { tag: 'null', value: null }],
            ['a', { tag: 'null', value: null }],
          ],
        },
        { registry: JSON_VALUE_REGISTRY },
      ).ok,
    ).toBe(false);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(canonicalJson(cycle).ok).toBe(false);
  });
});

describe('identities', () => {
  it('validates typed identifiers and full domain-separated hashes', () => {
    const invocation = ids.invocation('invocation:0123456789abcdef0123456789abcdef');
    expect(String(ids.request(invocation, 7))).toBe('request:0123456789abcdef0123456789abcdef:7');
    expect(String(ids.module('module:@host/api'))).toBe('module:@host/api');
    expect(() => ids.operation('effect:tasks.create')).toThrow();
    expect(String(hash('source', Uint8Array.of(1)))).toBe(
      'd8e0671485299b0d850838d8b99972fa4c6d404061f3ea340761e1e6a3fdb5c1',
    );
    expect(hash('source', Uint8Array.of(1))).not.toBe(hash('ir', Uint8Array.of(1)));
  });
});

describe('stable failure catalog', () => {
  it('has one deterministic owner and meaning for every closed public code', () => {
    const expectedCodes = new Set<string>([
      ...COMPILER_DIAGNOSTIC_CODES,
      ...EXECUTION_ERROR_CODES,
      ...HOST_FAILURE_CODES,
      'adapter_failure',
      'artifact_verification_failed',
      'bridge_closed',
      'capacity_exceeded',
      'fingerprint_mismatch',
      'graph_limit_exceeded',
      'invalid_contract_digest',
      'invalid_definition_id',
      'invalid_request',
      'invalid_schema',
      'invalid_value',
      'limit_exceeded',
      'malformed_cbor',
      'missing_definition',
      'noncanonical_cbor',
      'schema_mismatch',
      'trailing_bytes',
      'unknown_type',
      'unsupported_version',
      'worker_close_timeout',
      'worker_identity_mismatch',
      'worker_lost',
      'worker_start_failed',
      'worker_start_timeout',
    ]);
    const codes: string[] = DIAGNOSTIC_CATALOG.map((entry) => entry.code);
    const meanings = DIAGNOSTIC_CATALOG.map((entry) => entry.meaning);
    expect(codes).toEqual([...codes].sort((left, right) => left.localeCompare(right)));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(meanings).size).toBe(meanings.length);
    expect(new Set(codes)).toEqual(expectedCodes);
    expect(COMPILER_DIAGNOSTIC_CODES.every((code) => code.startsWith('SS_'))).toBe(true);
    expect([...COMPILER_DIAGNOSTIC_CODES]).toEqual(
      [...COMPILER_DIAGNOSTIC_CODES].sort((left, right) => left.localeCompare(right)),
    );
    for (const entry of DIAGNOSTIC_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.fields)).toBe(true);
      expect(entry.owner).not.toContain('pass');
      expect(entry.meaning.length).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_LENGTH);
      expect(new Set(entry.fields).size).toBe(entry.fields.length);
    }
  });

  it('bounds validation paths and safe detail without exposing the rejected value', () => {
    let schema: Schema = { kind: 'int64' };
    let value: unknown = 'SUPER_SECRET_VALUE';
    for (let index = 0; index < MAX_FAILURE_PATH_SEGMENTS + 16; index++) {
      schema = { kind: 'record', fields: [{ name: `field${index}`, schema }] };
      value = { [`field${index}`]: value };
    }
    const result = encodeCanonical(schema, value, {
      limits: { maxBytes: 1024 * 1024, maxDepth: 1024, maxNodes: 1024 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.path.length).toBe(MAX_FAILURE_PATH_SEGMENTS);
      expect(result.failure.detail?.length ?? 0).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_LENGTH);
      expect(JSON.stringify(result.failure)).not.toContain('SUPER_SECRET_VALUE');
    }
  });
});
