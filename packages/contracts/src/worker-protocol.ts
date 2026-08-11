/** Closed worker-protocol message kinds. */
export const WORKER_PROTOCOL_MESSAGE_KINDS = Object.freeze([
  'session.hello',
  'session.welcome',
  'session.incompatible',
  'bridge.check.request',
  'bridge.check.result',
  'bridge.inspect.request',
  'bridge.inspect.result',
  'bridge.apply_semantic_edits.request',
  'bridge.apply_semantic_edits.result',
  'bridge.execute.request',
  'bridge.execute.result',
  'bridge.cancel.request',
  'bridge.cancel.result',
  'session.close.request',
  'session.close.result',
  'action.request',
  'action.outcome',
  'protocol.error',
] as const);

export type WorkerProtocolMessageKind = (typeof WORKER_PROTOCOL_MESSAGE_KINDS)[number];

const MESSAGE_KINDS = new Set<string>(WORKER_PROTOCOL_MESSAGE_KINDS);
const FIELD = /^[a-z][a-z0-9_]*$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const MAX_DETAIL = 160;
const MAX_PATH = 64;

/** Independent byte, depth, and item ceilings for one CBOR item. */
export interface WorkerProtocolCodecLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const STANDARD_WORKER_ENVELOPE_LIMITS: WorkerProtocolCodecLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 1_000_000,
});

export const STANDARD_WORKER_PAYLOAD_LIMITS: WorkerProtocolCodecLimits = Object.freeze({
  maxBytes: 16_700_000,
  maxDepth: 128,
  maxNodes: 1_000_000,
});

/** Stable failures owned by the bounded envelope and payload codecs. */
export const WORKER_PROTOCOL_FAILURE_CODES = Object.freeze([
  'frame_length_zero',
  'frame_too_large',
  'truncated_frame',
  'frame_timeout',
  'malformed_cbor',
  'noncanonical_cbor',
  'envelope_schema',
  'payload_schema',
  'protocol_limit_exceeded',
  'unsupported_envelope_version',
  'unknown_message_kind',
] as const);

export type WorkerProtocolFailureCode = (typeof WORKER_PROTOCOL_FAILURE_CODES)[number];

export interface WorkerProtocolCodecFailure {
  readonly code: WorkerProtocolFailureCode;
  readonly path: readonly (string | number)[];
  readonly byteOffset?: number;
  readonly detail?: string;
}

export type WorkerProtocolCodecResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: WorkerProtocolCodecFailure }>;

export type WorkerProtocolLiteral = null | boolean | bigint | string;

export interface WorkerProtocolRecordField {
  readonly name: string;
  readonly schema: WorkerProtocolSchema;
  readonly optional?: boolean;
}

/** Closed schema vocabulary used by every typed worker-protocol payload codec. */
export type WorkerProtocolSchema =
  | Readonly<{ kind: 'unit' }>
  | Readonly<{ kind: 'boolean' }>
  | Readonly<{ kind: 'uint'; minimum?: bigint; maximum?: bigint }>
  | Readonly<{ kind: 'int'; minimum?: bigint; maximum?: bigint }>
  | Readonly<{ kind: 'float64'; minimum?: number; maximum?: number }>
  | Readonly<{ kind: 'text'; maxBytes?: number }>
  | Readonly<{ kind: 'bytes'; maxBytes?: number }>
  | Readonly<{ kind: 'array'; item: WorkerProtocolSchema; maxItems?: number }>
  | Readonly<{ kind: 'record'; fields: readonly WorkerProtocolRecordField[] }>
  | Readonly<{ kind: 'literal'; value: WorkerProtocolLiteral }>
  | Readonly<{ kind: 'oneOf'; choices: readonly WorkerProtocolSchema[] }>;

export interface WorkerProtocolPayload<T = unknown> {
  readonly kind: WorkerProtocolMessageKind;
  readonly schema: WorkerProtocolSchema;
  readonly __type?: T;
}

export interface WorkerProtocolEnvelope {
  readonly version: 1;
  readonly kind: WorkerProtocolMessageKind;
  readonly id: bigint;
  readonly replyTo: bigint | null;
  readonly payload: Uint8Array;
}

export interface WorkerProtocolEnvelopeCodecOptions {
  readonly envelopeLimits?: WorkerProtocolCodecLimits;
  readonly payloadLimits?: WorkerProtocolCodecLimits;
}

type Path = readonly (string | number)[];

class CodecFault {
  constructor(readonly failure: WorkerProtocolCodecFailure) {}
}

function fault(code: WorkerProtocolFailureCode, path: Path, detail?: string, byteOffset?: number): never {
  throw new CodecFault(
    Object.freeze({
      code,
      path: Object.freeze(path.slice(0, MAX_PATH)),
      ...(byteOffset === undefined ? {} : { byteOffset }),
      ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_DETAIL) }),
    }),
  );
}

function resultFailure(error: unknown): WorkerProtocolCodecResult<never> {
  if (error instanceof CodecFault) return Object.freeze({ ok: false, failure: error.failure });
  return Object.freeze({
    ok: false,
    failure: Object.freeze({
      code: 'payload_schema' as const,
      path: Object.freeze([]),
      detail: 'unexpected protocol codec failure',
    }),
  });
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fault('protocol_limit_exceeded', [], `invalid ${name}`);
}

function validateLimits(limits: WorkerProtocolCodecLimits): void {
  validateLimit(limits.maxBytes, 'maxBytes');
  validateLimit(limits.maxDepth, 'maxDepth');
  validateLimit(limits.maxNodes, 'maxNodes');
}

function validUnicode(value: string, code: WorkerProtocolFailureCode, path: Path): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fault(code, path, 'invalid Unicode text');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fault(code, path, 'invalid Unicode text');
    }
  }
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && descriptor.enumerable,
  );
}

function dataProperty(record: Readonly<Record<string, unknown>>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function dataItem(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function validateBound(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`invalid ${name}`);
}

function validateSchema(root: WorkerProtocolSchema): void {
  const pending: Array<Readonly<{ schema: WorkerProtocolSchema; leaving: boolean }>> = [
    { schema: root, leaving: false },
  ];
  const active = new Set<object>();
  const validated = new Set<object>();
  while (pending.length > 0) {
    const { schema, leaving } = pending.pop() as (typeof pending)[number];
    if (leaving) {
      active.delete(schema);
      validated.add(schema);
      continue;
    }
    if (validated.has(schema)) continue;
    if (active.has(schema)) throw new TypeError('cyclic worker protocol schema');
    active.add(schema);
    pending.push({ schema, leaving: true });
    if (schema.kind === 'uint') {
      const minimum = schema.minimum ?? 0n;
      const maximum = schema.maximum ?? MAX_UINT64;
      if (minimum < 0n || maximum > MAX_UINT64 || minimum > maximum) throw new TypeError('invalid uint bounds');
    } else if (schema.kind === 'int') {
      const minimum = schema.minimum ?? MIN_INT64;
      const maximum = schema.maximum ?? MAX_INT64;
      if (minimum < MIN_INT64 || maximum > MAX_INT64 || minimum > maximum) throw new TypeError('invalid int bounds');
    } else if (schema.kind === 'float64') {
      const bounds = [schema.minimum, schema.maximum].filter((item) => item !== undefined);
      if (
        bounds.some((item) => !Number.isFinite(item) || Object.is(item, -0)) ||
        (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)
      )
        throw new TypeError('invalid float64 bounds');
    } else if (schema.kind === 'text' || schema.kind === 'bytes') {
      validateBound(schema.maxBytes, 'maxBytes');
    } else if (schema.kind === 'array') {
      validateBound(schema.maxItems, 'maxItems');
      pending.push({ schema: schema.item, leaving: false });
    } else if (schema.kind === 'record') {
      const names = new Set<string>();
      for (const field of schema.fields) {
        if (!FIELD.test(field.name) || names.has(field.name))
          throw new TypeError('invalid or duplicate protocol field');
        names.add(field.name);
        pending.push({ schema: field.schema, leaving: false });
      }
    } else if (schema.kind === 'literal') {
      if (!(
        schema.value === null ||
        typeof schema.value === 'boolean' ||
        typeof schema.value === 'string' ||
        typeof schema.value === 'bigint'
      ))
        throw new TypeError('invalid protocol literal');
    } else if (schema.kind === 'oneOf') {
      if (schema.choices.length < 2) throw new TypeError('oneOf requires at least two choices');
      for (const choice of schema.choices) pending.push({ schema: choice, leaving: false });
    }
  }
}

function freezeSchema<T extends WorkerProtocolSchema>(root: T): T {
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(value);
  }
  return root;
}

/** Defines one immutable payload contract bound to a published protocol message kind. */
export function defineWorkerProtocolPayload<T = unknown>(
  kind: WorkerProtocolMessageKind,
  schema: WorkerProtocolSchema,
): WorkerProtocolPayload<T> {
  if (!MESSAGE_KINDS.has(kind)) throw new TypeError('unknown worker protocol message kind');
  validateSchema(schema);
  return Object.freeze({ kind, schema: freezeSchema(schema) });
}

function header(major: number, argument: bigint): number[] {
  if (argument < 24n) return [(major << 5) | Number(argument)];
  if (argument <= 0xffn) return [(major << 5) | 24, Number(argument)];
  if (argument <= 0xffffn) return [(major << 5) | 25, Number(argument >> 8n), Number(argument & 0xffn)];
  const width = argument <= 0xffff_ffffn ? 4 : 8;
  const output = [(major << 5) | (width === 4 ? 26 : 27)];
  for (let shift = width * 8 - 8; shift >= 0; shift -= 8) output.push(Number((argument >> BigInt(shift)) & 0xffn));
  return output;
}

function compareEncodedKey(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

class Encoder {
  readonly output: number[] = [];
  nodes = 0;

  constructor(
    readonly limits: WorkerProtocolCodecLimits,
    readonly schemaCode: 'envelope_schema' | 'payload_schema',
  ) {}

  append(bytes: readonly number[] | Uint8Array, path: Path): void {
    if (this.output.length + bytes.length > this.limits.maxBytes) fault('protocol_limit_exceeded', path, 'maxBytes');
    for (const byte of bytes) this.output.push(byte);
  }

  node(depth: number, path: Path): void {
    if (depth > this.limits.maxDepth) fault('protocol_limit_exceeded', path, 'maxDepth');
    if (++this.nodes > this.limits.maxNodes) fault('protocol_limit_exceeded', path, 'maxNodes');
  }

  textBytes(value: string, path: Path): Uint8Array {
    validUnicode(value, this.schemaCode, path);
    return new TextEncoder().encode(value);
  }

  encodedText(value: string, path: Path): number[] {
    const text = this.textBytes(value, path);
    return [...header(3, BigInt(text.length)), ...text];
  }

  encode(schema: WorkerProtocolSchema, value: unknown, path: Path = [], depth = 0): void {
    this.node(depth, path);
    if (schema.kind === 'oneOf') {
      const selected = schema.choices.find((choice) => accepts(choice, value, true));
      if (!selected) fault(this.schemaCode, path, 'value matches no closed choice');
      this.nodes--;
      this.encode(selected, value, path, depth);
      return;
    }
    if (schema.kind === 'literal') {
      if (!Object.is(value, schema.value)) fault(this.schemaCode, path, 'literal mismatch');
      this.nodes--;
      this.encode(literalSchema(schema.value), value, path, depth);
      return;
    }
    if (schema.kind === 'unit') {
      if (value !== null) fault(this.schemaCode, path, 'expected null');
      this.append([0xf6], path);
    } else if (schema.kind === 'boolean') {
      if (typeof value !== 'boolean') fault(this.schemaCode, path, 'expected boolean');
      this.append([value ? 0xf5 : 0xf4], path);
    } else if (schema.kind === 'uint') {
      const minimum = schema.minimum ?? 0n;
      const maximum = schema.maximum ?? MAX_UINT64;
      if (typeof value !== 'bigint' || value < minimum || value > maximum)
        fault(this.schemaCode, path, 'expected bounded uint');
      this.append(header(0, value), path);
    } else if (schema.kind === 'int') {
      const minimum = schema.minimum ?? MIN_INT64;
      const maximum = schema.maximum ?? MAX_INT64;
      if (typeof value !== 'bigint' || value < minimum || value > maximum)
        fault(this.schemaCode, path, 'expected bounded int');
      this.append(header(value >= 0n ? 0 : 1, value >= 0n ? value : -1n - value), path);
    } else if (schema.kind === 'float64') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum)
      )
        fault(this.schemaCode, path, 'expected finite float64');
      const bytes = new Uint8Array(9);
      bytes[0] = 0xfb;
      new DataView(bytes.buffer).setFloat64(1, Object.is(value, -0) ? 0 : value);
      this.append(bytes, path);
    } else if (schema.kind === 'text') {
      if (typeof value !== 'string') fault(this.schemaCode, path, 'expected text');
      const text = this.textBytes(value, path);
      if (schema.maxBytes !== undefined && text.length > schema.maxBytes)
        fault(this.schemaCode, path, 'text exceeds maxBytes');
      this.append(header(3, BigInt(text.length)), path);
      this.append(text, path);
    } else if (schema.kind === 'bytes') {
      const bytes = byteValue(value);
      if (!bytes) fault(this.schemaCode, path, 'expected bytes');
      if (schema.maxBytes !== undefined && bytes.length > schema.maxBytes)
        fault(this.schemaCode, path, 'bytes exceed maxBytes');
      this.append(header(2, BigInt(bytes.length)), path);
      this.append(bytes, path);
    } else if (schema.kind === 'array') {
      if (!Array.isArray(value) || !denseDataArray(value)) fault(this.schemaCode, path, 'expected dense array');
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        fault(this.schemaCode, path, 'array exceeds maxItems');
      this.append(header(4, BigInt(value.length)), path);
      for (let index = 0; index < value.length; index++)
        this.encode(schema.item, dataItem(value, index), [...path, index], depth + 1);
    } else {
      if (!plainRecord(value)) fault(this.schemaCode, path, 'expected plain record');
      const names = new Set(schema.fields.map((field) => field.name));
      const actual = Object.keys(value);
      if (actual.some((name) => !names.has(name))) fault(this.schemaCode, path, 'unknown record field');
      const present = schema.fields.filter((field) => Object.hasOwn(value, field.name));
      if (schema.fields.some((field) => !field.optional && !Object.hasOwn(value, field.name)))
        fault(this.schemaCode, path, 'missing record field');
      const entries = present
        .map((field) => ({ field, key: this.encodedText(field.name, [...path, field.name]) }))
        .sort((left, right) => compareEncodedKey(left.key, right.key));
      this.append(header(5, BigInt(entries.length)), path);
      for (const entry of entries) {
        this.node(depth + 1, [...path, entry.field.name]);
        this.append(entry.key, [...path, entry.field.name]);
        this.encode(entry.field.schema, dataProperty(value, entry.field.name), [...path, entry.field.name], depth + 1);
      }
    }
  }
}

function literalSchema(value: WorkerProtocolLiteral): WorkerProtocolSchema {
  if (value === null) return { kind: 'unit' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'string') return { kind: 'text' };
  return value >= 0n
    ? { kind: 'uint', minimum: value, maximum: value }
    : { kind: 'int', minimum: value, maximum: value };
}

function byteValue(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (
    Array.isArray(value) &&
    denseDataArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  )
    return Uint8Array.from(value);
  return undefined;
}

function denseDataArray(value: readonly unknown[]): boolean {
  if (Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function accepts(schema: WorkerProtocolSchema, value: unknown, encoding = false): boolean {
  try {
    validateValue(schema, value, [], encoding);
    return true;
  } catch {
    return false;
  }
}

function validateValue(schema: WorkerProtocolSchema, value: unknown, path: Path, encoding = false): void {
  if (schema.kind === 'oneOf') {
    if (!schema.choices.some((choice) => accepts(choice, value, encoding))) fault('payload_schema', path);
  } else if (schema.kind === 'literal') {
    if (!Object.is(value, schema.value)) fault('payload_schema', path);
  } else if (schema.kind === 'unit') {
    if (value !== null) fault('payload_schema', path);
  } else if (schema.kind === 'boolean') {
    if (typeof value !== 'boolean') fault('payload_schema', path);
  } else if (schema.kind === 'uint') {
    if (typeof value !== 'bigint' || value < (schema.minimum ?? 0n) || value > (schema.maximum ?? MAX_UINT64))
      fault('payload_schema', path);
  } else if (schema.kind === 'int') {
    if (typeof value !== 'bigint' || value < (schema.minimum ?? MIN_INT64) || value > (schema.maximum ?? MAX_INT64))
      fault('payload_schema', path);
  } else if (schema.kind === 'float64') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (!encoding && Object.is(value, -0)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      fault('payload_schema', path);
  } else if (schema.kind === 'text') {
    if (typeof value !== 'string') fault('payload_schema', path);
    const length = new TextEncoder().encode(value).length;
    if (schema.maxBytes !== undefined && length > schema.maxBytes) fault('payload_schema', path);
  } else if (schema.kind === 'bytes') {
    const bytes = byteValue(value);
    if (!bytes || (schema.maxBytes !== undefined && bytes.length > schema.maxBytes)) fault('payload_schema', path);
  } else if (schema.kind === 'array') {
    if (!Array.isArray(value) || !denseDataArray(value)) fault('payload_schema', path);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fault('payload_schema', path);
    for (let index = 0; index < value.length; index++)
      validateValue(schema.item, dataItem(value, index), [...path, index], encoding);
  } else {
    if (!plainRecord(value)) fault('payload_schema', path);
    const names = new Set(schema.fields.map((field) => field.name));
    if (Object.keys(value).some((name) => !names.has(name))) fault('payload_schema', path);
    for (const field of schema.fields) {
      if (!Object.hasOwn(value, field.name)) {
        if (!field.optional) fault('payload_schema', [...path, field.name]);
      } else validateValue(field.schema, dataProperty(value, field.name), [...path, field.name], encoding);
    }
  }
}

class Decoder {
  offset = 0;
  nodes = 0;
  readonly text = new TextDecoder('utf-8', { fatal: true });

  constructor(
    readonly bytes: Uint8Array,
    readonly limits: WorkerProtocolCodecLimits,
    readonly schemaCode: 'envelope_schema' | 'payload_schema',
  ) {
    if (bytes.length > limits.maxBytes) fault('protocol_limit_exceeded', [], 'maxBytes', 0);
  }

  byte(path: Path): number {
    if (this.offset >= this.bytes.length) fault('malformed_cbor', path, 'truncated CBOR', this.offset);
    return this.bytes[this.offset++] as number;
  }

  argument(additional: number, path: Path): bigint {
    if (additional < 24) return BigInt(additional);
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (additional === 31) fault('noncanonical_cbor', path, 'indefinite-length item', this.offset - 1);
    if (width === 0) fault('malformed_cbor', path, 'reserved CBOR additional information', this.offset - 1);
    let value = 0n;
    for (let index = 0; index < width; index++) value = (value << 8n) | BigInt(this.byte(path));
    const minimum = width === 1 ? 24n : width === 2 ? 256n : width === 4 ? 65_536n : 4_294_967_296n;
    if (value < minimum) fault('noncanonical_cbor', path, 'non-minimal integer or length', this.offset - width - 1);
    return value;
  }

  length(additional: number, path: Path): number {
    const value = this.argument(additional, path);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(this.bytes.length - this.offset))
      fault('malformed_cbor', path, 'declared length exceeds input', this.offset);
    return Number(value);
  }

  node(depth: number, path: Path): void {
    if (depth > this.limits.maxDepth) fault('protocol_limit_exceeded', path, 'maxDepth', this.offset);
    if (++this.nodes > this.limits.maxNodes) fault('protocol_limit_exceeded', path, 'maxNodes', this.offset);
  }

  value(path: Path = [], depth = 0): unknown {
    this.node(depth, path);
    const start = this.offset;
    const initial = this.byte(path);
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 0) return this.argument(additional, path);
    if (major === 1) {
      const value = this.argument(additional, path);
      if (value > MAX_INT64) fault(this.schemaCode, path, 'negative integer out of range', start);
      return -1n - value;
    }
    if (major === 2) {
      const length = this.length(additional, path);
      const end = this.offset + length;
      const value = this.bytes.slice(this.offset, end);
      this.offset = end;
      return value;
    }
    if (major === 3) return this.string(additional, path);
    if (major === 4) {
      const length = this.length(additional, path);
      const values: unknown[] = [];
      for (let index = 0; index < length; index++) values.push(this.value([...path, index], depth + 1));
      return Object.freeze(values);
    }
    if (major === 5) {
      const length = this.length(additional, path);
      const record: Record<string, unknown> = {};
      let previous: Uint8Array | undefined;
      for (let index = 0; index < length; index++) {
        const keyStart = this.offset;
        this.node(depth + 1, path);
        const keyInitial = this.byte(path);
        if (keyInitial >> 5 !== 3) fault(this.schemaCode, path, 'map key must be text', keyStart);
        const key = this.string(keyInitial & 31, path);
        const encoded = this.bytes.slice(keyStart, this.offset);
        if (previous && compareEncodedKey(previous, encoded) >= 0)
          fault('noncanonical_cbor', path, 'duplicate or out-of-order map key', keyStart);
        previous = encoded;
        if (Object.hasOwn(record, key)) fault('noncanonical_cbor', path, 'duplicate map key', keyStart);
        record[key] = this.value([...path, key], depth + 1);
      }
      return Object.freeze(record);
    }
    if (major === 6) fault('noncanonical_cbor', path, 'CBOR tags are forbidden', start);
    if (additional >= 28) fault('malformed_cbor', path, 'reserved or misplaced CBOR simple value', start);
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    if (additional === 27) {
      if (this.offset + 8 > this.bytes.length) fault('malformed_cbor', path, 'truncated float64', this.offset);
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0);
      this.offset += 8;
      if (!Number.isFinite(value) || Object.is(value, -0))
        fault('noncanonical_cbor', path, 'invalid canonical float64', start);
      return value;
    }
    if (additional >= 24 && additional <= 26) {
      const width = additional === 24 ? 1 : additional === 25 ? 2 : 4;
      if (this.offset + width > this.bytes.length)
        fault('malformed_cbor', path, 'truncated CBOR simple or float value', this.offset);
    }
    fault('noncanonical_cbor', path, 'forbidden CBOR simple or float value', start);
  }

  string(additional: number, path: Path): string {
    const length = this.length(additional, path);
    const start = this.offset;
    const end = start + length;
    let value: string;
    try {
      value = this.text.decode(this.bytes.subarray(start, end));
    } catch {
      fault('malformed_cbor', path, 'invalid UTF-8', start);
    }
    this.offset = end;
    validUnicode(value, 'malformed_cbor', path);
    return value;
  }
}

function decodeItem(
  bytes: Uint8Array,
  limits: WorkerProtocolCodecLimits,
  schemaCode: 'envelope_schema' | 'payload_schema',
): unknown {
  validateLimits(limits);
  const decoder = new Decoder(bytes, limits, schemaCode);
  const value = decoder.value();
  if (decoder.offset !== bytes.length) fault('malformed_cbor', [], 'trailing bytes', decoder.offset);
  return value;
}

/** Encodes one value against its kind-bound closed payload contract. */
export function encodeWorkerProtocolPayload<T>(
  contract: WorkerProtocolPayload<T>,
  value: T,
  limits: WorkerProtocolCodecLimits = STANDARD_WORKER_PAYLOAD_LIMITS,
): WorkerProtocolCodecResult<Uint8Array> {
  try {
    validateLimits(limits);
    const encoder = new Encoder(limits, 'payload_schema');
    encoder.encode(contract.schema, value);
    return Object.freeze({ ok: true, value: Uint8Array.from(encoder.output) });
  } catch (error) {
    return resultFailure(error);
  }
}

/** Decodes and validates one value against its kind-bound closed payload contract. */
export function decodeWorkerProtocolPayload<T>(
  contract: WorkerProtocolPayload<T>,
  bytes: Uint8Array,
  limits: WorkerProtocolCodecLimits = STANDARD_WORKER_PAYLOAD_LIMITS,
): WorkerProtocolCodecResult<T> {
  try {
    if (!(bytes instanceof Uint8Array)) fault('payload_schema', [], 'payload must be Uint8Array');
    const value = decodeItem(bytes, limits, 'payload_schema');
    validateValue(contract.schema, value, []);
    return Object.freeze({ ok: true, value: value as T });
  } catch (error) {
    return resultFailure(error);
  }
}

const ENVELOPE_SCHEMA: WorkerProtocolSchema = freezeSchema({
  kind: 'record',
  fields: [
    { name: 'version', schema: { kind: 'uint' } },
    { name: 'kind', schema: { kind: 'text', maxBytes: 64 } },
    { name: 'id', schema: { kind: 'uint', minimum: 1n, maximum: MAX_UINT64 } },
    {
      name: 'reply_to',
      schema: {
        kind: 'oneOf',
        choices: [{ kind: 'uint', minimum: 1n, maximum: MAX_UINT64 }, { kind: 'unit' }],
      },
    },
    { name: 'payload', schema: { kind: 'bytes', maxBytes: STANDARD_WORKER_PAYLOAD_LIMITS.maxBytes } },
  ],
});

function envelopeLimits(options?: WorkerProtocolEnvelopeCodecOptions): WorkerProtocolCodecLimits {
  return options?.envelopeLimits ?? STANDARD_WORKER_ENVELOPE_LIMITS;
}

function payloadLimits(options?: WorkerProtocolEnvelopeCodecOptions): WorkerProtocolCodecLimits {
  return options?.payloadLimits ?? STANDARD_WORKER_PAYLOAD_LIMITS;
}

function validateEnvelopePayload(bytes: Uint8Array, options?: WorkerProtocolEnvelopeCodecOptions): void {
  decodeItem(bytes, payloadLimits(options), 'payload_schema');
}

/** Encodes one canonical control envelope after independently validating its nested CBOR payload. */
export function encodeWorkerProtocolEnvelope(
  envelope: WorkerProtocolEnvelope,
  options?: WorkerProtocolEnvelopeCodecOptions,
): WorkerProtocolCodecResult<Uint8Array> {
  try {
    if (envelope.version !== 1) fault('unsupported_envelope_version', ['version']);
    if (!MESSAGE_KINDS.has(envelope.kind)) fault('unknown_message_kind', ['kind']);
    validateEnvelopePayload(envelope.payload, options);
    const limits = envelopeLimits(options);
    validateLimits(limits);
    const encoder = new Encoder(limits, 'envelope_schema');
    encoder.encode(ENVELOPE_SCHEMA, {
      version: BigInt(envelope.version),
      kind: envelope.kind,
      id: envelope.id,
      reply_to: envelope.replyTo,
      payload: envelope.payload,
    });
    return Object.freeze({ ok: true, value: Uint8Array.from(encoder.output) });
  } catch (error) {
    return resultFailure(error);
  }
}

/** Decodes one canonical control envelope and independently validates its nested CBOR payload spelling. */
export function decodeWorkerProtocolEnvelope(
  bytes: Uint8Array,
  options?: WorkerProtocolEnvelopeCodecOptions,
): WorkerProtocolCodecResult<WorkerProtocolEnvelope> {
  try {
    if (!(bytes instanceof Uint8Array)) fault('envelope_schema', [], 'envelope must be Uint8Array');
    const value = decodeItem(bytes, envelopeLimits(options), 'envelope_schema');
    try {
      validateValue(ENVELOPE_SCHEMA, value, []);
    } catch (error) {
      if (error instanceof CodecFault) fault('envelope_schema', error.failure.path, error.failure.detail);
      throw error;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const version = dataProperty(record, 'version');
    if (version !== 1n) fault('unsupported_envelope_version', ['version']);
    const kind = dataProperty(record, 'kind');
    if (typeof kind !== 'string' || !MESSAGE_KINDS.has(kind)) fault('unknown_message_kind', ['kind']);
    const payload = dataProperty(record, 'payload');
    if (!(payload instanceof Uint8Array)) fault('envelope_schema', ['payload']);
    validateEnvelopePayload(payload, options);
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        version: 1 as const,
        kind: kind as WorkerProtocolMessageKind,
        id: dataProperty(record, 'id') as bigint,
        replyTo: dataProperty(record, 'reply_to') as bigint | null,
        payload,
      }),
    });
  } catch (error) {
    return resultFailure(error);
  }
}
