import { describe, expect, it } from 'bun:test';

import {
  JSON_VALUE_REGISTRY,
  JSON_VALUE_TYPE,
  canonicalJson,
  canonicalize,
  checkCompatibility,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  optionSchema,
  resultSchema,
  type ContractFailureCode,
  type Schema,
  type TypeDefinition,
} from './index.js';

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
    expect(encodedHex({
      kind: 'record',
      fields: [{ name: 'name', schema: { kind: 'string' } }, { name: 'count', schema: { kind: 'int64' } }],
    }, { count: 1n, name: 'x' })).toBe('82617801');
    expect(encodedHex(optionSchema({ kind: 'int64' }), { tag: 'some', value: 1n })).toBe('8264736f6d6501');
    expect(encodedHex({ kind: 'tuple', items: [{ kind: 'boolean' }, { kind: 'string' }] }, [false, 'x'])).toBe('82f46178');
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
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { getterRan = true; return 1n; } });
    expect(encodeCanonical({ kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] }, accessor).ok).toBe(false);
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
    expect(encodeCanonical({ kind: 'ref', type: tree }, value, { registry, limits: { maxBytes: 4096, maxDepth: 8, maxNodes: 100 } }).ok).toBe(false);

    const impossible = ids.type('type:test.impossible');
    expect(() => defineSchemaRegistry([{
      id: impossible,
      fingerprint,
      schema: { kind: 'record', fields: [{ name: 'next', schema: { kind: 'ref', type: impossible } }] },
    }])).toThrow('no finite inhabitant');
  });

  it('uses the accepted sorted tagged JsonValue representation', () => {
    const result = canonicalJson({ z: null, a: [true, -0] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      tag: 'object',
      value: [
        ['a', { tag: 'array', value: [{ tag: 'boolean', value: true }, { tag: 'number', value: 0 }] }],
        ['z', { tag: 'null', value: null }],
      ],
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(encodeCanonical({ kind: 'ref', type: JSON_VALUE_TYPE }, result.value, { registry: JSON_VALUE_REGISTRY }).ok).toBe(true);
    expect(encodeCanonical({ kind: 'ref', type: JSON_VALUE_TYPE }, {
      tag: 'object',
      value: [['z', { tag: 'null', value: null }], ['a', { tag: 'null', value: null }]],
    }, { registry: JSON_VALUE_REGISTRY }).ok).toBe(false);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(canonicalJson(cycle).ok).toBe(false);
  });
});

describe('identities and compatibility', () => {
  it('validates typed identifiers and full domain-separated hashes', () => {
    const invocation = ids.invocation('invocation:0123456789abcdef0123456789abcdef');
    expect(String(ids.request(invocation, 7))).toBe('request:0123456789abcdef0123456789abcdef:7');
    expect(String(ids.module('module:@host/api'))).toBe('module:@host/api');
    expect(() => ids.operation('effect:tasks.create')).toThrow();
    expect(String(hash('source', Uint8Array.of(1)))).toBe('d8e0671485299b0d850838d8b99972fa4c6d404061f3ea340761e1e6a3fdb5c1');
    expect(hash('source', Uint8Array.of(1))).not.toBe(hash('ir', Uint8Array.of(1)));
  });

  it('fails closed on independent version dimensions', () => {
    const contractId = ids.contract('contract:test.host');
    const failures = checkCompatibility(
      { language: { major: 1, minor: 1 }, ir: { major: 1, minor: 0 }, abi: { major: 1, minor: 0 }, contractId, contract: { major: 1, minor: 2, patch: 0 } },
      { language: { major: 1, minor: 2 }, ir: { major: 2, minor: 0 }, abi: { major: 1, minor: 0 }, contractId, contract: { major: 1, minor: 1, patch: 0 } },
    );
    expect(failures.map((failure) => failure.dimension)).toEqual(['language', 'ir']);
    expect(Object.isFrozen(failures)).toBe(true);
  });
});
