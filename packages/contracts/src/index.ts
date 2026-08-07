import { createHash } from 'node:crypto';

declare const brand: unique symbol;

export type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type ContractId = Branded<string, 'ContractId'>;
export type TypeId = Branded<string, 'TypeId'>;
export type EffectId = Branded<string, 'EffectId'>;
export type CapabilityId = Branded<string, 'CapabilityId'>;
export type OperationId = Branded<string, 'OperationId'>;
export type SlotId = Branded<string, 'SlotId'>;
export type ModuleId = Branded<string, 'ModuleId'>;
export type SymbolId = Branded<string, 'SymbolId'>;
export type ActionSiteId = Branded<string, 'ActionSiteId'>;
export type InvocationId = Branded<string, 'InvocationId'>;
export type RequestId = Branded<string, 'RequestId'>;
export type Sha256Digest = Branded<string, 'Sha256Digest'>;
export type SourceHash = Branded<string, 'SourceHash'>;
export type ProgramHash = Branded<string, 'ProgramHash'>;
export type IrDigest = Branded<string, 'IrDigest'>;

const HOST_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const MODULE_NAME = /^@?[a-z][a-z0-9-]*(?:[/.][a-z][a-z0-9-]*)*$/;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VARIANT_TAG = /^[a-z][a-z0-9_-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INVOCATION = /^[0-9a-f]{32}$/;
const MAX_ID_NAME_BYTES = 128;

type ContractOwnedId = TypeId | EffectId | CapabilityId | OperationId | SlotId;
type IdPrefix = 'contract' | 'type' | 'effect' | 'capability' | 'operation' | 'slot' | 'module';

function parseNamedId<Id extends string>(prefix: IdPrefix, value: string): Id {
  const expected = `${prefix}:`;
  const name = value.startsWith(expected) ? value.slice(expected.length) : '';
  const validName = prefix === 'module' ? MODULE_NAME.test(name) : HOST_NAME.test(name);
  if (!validName || utf8Length(name) > MAX_ID_NAME_BYTES) {
    throw new TypeError(`invalid ${prefix} identifier`);
  }
  return value as Id;
}

export const ids = Object.freeze({
  contract: (value: string): ContractId => parseNamedId('contract', value),
  type: (value: string): TypeId => parseNamedId('type', value),
  effect: (value: string): EffectId => parseNamedId('effect', value),
  capability: (value: string): CapabilityId => parseNamedId('capability', value),
  operation: (value: string): OperationId => parseNamedId('operation', value),
  slot: (value: string): SlotId => parseNamedId('slot', value),
  module: (value: string): ModuleId => parseNamedId('module', value),
  symbol: (value: string): SymbolId => {
    const digest = value.startsWith('symbol:') ? value.slice(7) : '';
    if (!SHA256.test(digest)) throw new TypeError('invalid symbol identifier');
    return value as SymbolId;
  },
  actionSite: (value: string): ActionSiteId => {
    const digest = value.startsWith('action-site:') ? value.slice(12) : '';
    if (!SHA256.test(digest)) throw new TypeError('invalid action-site identifier');
    return value as ActionSiteId;
  },
  invocation: (value: string): InvocationId => {
    const opaque = value.startsWith('invocation:') ? value.slice(11) : '';
    if (!INVOCATION.test(opaque)) throw new TypeError('invalid invocation identifier');
    return value as InvocationId;
  },
  request: (invocation: InvocationId, sequence: number): RequestId => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('invalid request sequence');
    return `request:${invocation.slice(11)}:${sequence}` as RequestId;
  },
  parseRequest: (value: string): RequestId => {
    if (!/^request:[0-9a-f]{32}:(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError('invalid request identifier');
    const sequence = Number(value.slice(value.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(sequence)) throw new TypeError('invalid request sequence');
    return value as RequestId;
  },
});

export type HashDomain =
  | 'action-site'
  | 'artifact'
  | 'contract'
  | 'idempotency'
  | 'ir'
  | 'program'
  | 'source'
  | 'symbol'
  | 'type';

export function hash(domain: HashDomain, bytes: Uint8Array): Sha256Digest {
  return createHash('sha256')
    .update(`safescript:${domain}:v1\0`, 'utf8')
    .update(bytes)
    .digest('hex') as Sha256Digest;
}

export function derivedSymbolId(bytes: Uint8Array): SymbolId {
  return ids.symbol(`symbol:${hash('symbol', bytes)}`);
}

export function derivedActionSiteId(bytes: Uint8Array): ActionSiteId {
  return ids.actionSite(`action-site:${hash('action-site', bytes)}`);
}

export function sourceHash(bytes: Uint8Array): SourceHash {
  return hash('source', bytes) as unknown as SourceHash;
}

export interface Version {
  readonly major: number;
  readonly minor: number;
}

export interface SemVer extends Version {
  readonly patch: number;
  readonly prerelease?: string;
}

export interface CompilerVersion {
  readonly version: SemVer;
  readonly build: string;
}

export interface VersionRequirements {
  readonly language: Version;
  readonly ir: Version;
  readonly abi: Version;
  readonly contractId: ContractId;
  readonly contract: SemVer;
  readonly compiler?: CompilerVersion;
}

export interface VersionEnvelope<T> {
  readonly abiVersion: Version;
  readonly value: T;
}

export interface SupportedVersions {
  readonly language: Version;
  readonly ir: Version;
  readonly abi: Version;
  readonly contractId: ContractId;
  readonly contract: SemVer;
  readonly allowedCompilers?: readonly CompilerVersion[];
}

export type CompatibilityDimension = 'language' | 'ir' | 'abi' | 'contract' | 'compiler';

export interface CompatibilityFailure {
  readonly code: 'incompatible_version';
  readonly dimension: CompatibilityDimension;
}

function validVersion(version: Version): boolean {
  return Number.isSafeInteger(version.major) && version.major >= 0 && Number.isSafeInteger(version.minor) && version.minor >= 0;
}

function validSemVer(version: SemVer): boolean {
  return validVersion(version) && Number.isSafeInteger(version.patch) && version.patch >= 0 &&
    (version.prerelease === undefined || /^(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*$/.test(version.prerelease));
}

function acceptsMinor(supported: Version, required: Version): boolean {
  return validVersion(supported) && validVersion(required) && supported.major === required.major && supported.minor >= required.minor;
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  const leftParts = left.prerelease.split('.');
  const rightParts = right.prerelease.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^(?:0|[1-9][0-9]*)$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^(?:0|[1-9][0-9]*)$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function sameCompiler(left: CompilerVersion, right: CompilerVersion): boolean {
  return compareSemVer(left.version, right.version) === 0 && left.version.prerelease === right.version.prerelease && left.build === right.build;
}

export function checkCompatibility(supported: SupportedVersions, required: VersionRequirements): readonly CompatibilityFailure[] {
  const failures: CompatibilityFailure[] = [];
  for (const dimension of ['language', 'ir', 'abi'] as const) {
    if (!acceptsMinor(supported[dimension], required[dimension])) failures.push({ code: 'incompatible_version', dimension });
  }
  if (
    supported.contractId !== required.contractId ||
    !validSemVer(supported.contract) ||
    !validSemVer(required.contract) ||
    supported.contract.major !== required.contract.major ||
    compareSemVer(supported.contract, required.contract) < 0
  ) {
    failures.push({ code: 'incompatible_version', dimension: 'contract' });
  }
  if (
    required.compiler &&
    supported.allowedCompilers &&
    !supported.allowedCompilers.some((compiler) => sameCompiler(compiler, required.compiler as CompilerVersion))
  ) {
    failures.push({ code: 'incompatible_version', dimension: 'compiler' });
  }
  return Object.freeze(failures.map((failure) => Object.freeze(failure)));
}

export type CanonicalBytes = readonly number[];

export interface InstantValue {
  readonly epochSeconds: bigint;
  readonly nanoseconds: number;
}

export type UnitValue = null;
export type Option<T> = Readonly<{ tag: 'none'; value: UnitValue }> | Readonly<{ tag: 'some'; value: T }>;
export type Result<T, E> = Readonly<{ tag: 'ok'; value: T }> | Readonly<{ tag: 'error'; value: E }>;
export interface VariantValue { readonly tag: string; readonly value: CanonicalValue }
export interface RecordValue { readonly [key: string]: CanonicalValue }
export type CanonicalValue = UnitValue | boolean | bigint | number | string | CanonicalBytes | InstantValue | readonly CanonicalValue[] | RecordValue | VariantValue;

export type JsonValue =
  | Readonly<{ tag: 'null'; value: UnitValue }>
  | Readonly<{ tag: 'boolean'; value: boolean }>
  | Readonly<{ tag: 'number'; value: number }>
  | Readonly<{ tag: 'string'; value: string }>
  | Readonly<{ tag: 'array'; value: readonly JsonValue[] }>
  | Readonly<{ tag: 'object'; value: readonly (readonly [string, JsonValue])[] }>;

export interface UnitSchema { readonly kind: 'unit' }
export interface BooleanSchema { readonly kind: 'boolean' }
export interface Int64Schema { readonly kind: 'int64'; readonly minimum?: bigint; readonly maximum?: bigint }
export interface Float64Schema { readonly kind: 'float64'; readonly minimum?: number; readonly maximum?: number }
export interface StringSchema { readonly kind: 'string'; readonly maxBytes?: number }
export interface BytesSchema { readonly kind: 'bytes'; readonly maxBytes?: number }
export interface InstantSchema { readonly kind: 'instant'; readonly minimum?: InstantValue; readonly maximum?: InstantValue }
export interface ListSchema { readonly kind: 'list'; readonly item: Schema; readonly maxItems?: number }
export interface TupleSchema { readonly kind: 'tuple'; readonly items: readonly Schema[] }
export interface RecordField { readonly name: string; readonly schema: Schema }
export interface RecordSchema { readonly kind: 'record'; readonly fields: readonly RecordField[] }
export interface VariantCase { readonly tag: string; readonly schema: Schema }
export interface VariantSchema { readonly kind: 'variant'; readonly variants: readonly VariantCase[] }
export interface BrandSchema { readonly kind: 'brand'; readonly type: TypeId; readonly base: PrimitiveSchema }
export interface RefSchema { readonly kind: 'ref'; readonly type: TypeId }

export type PrimitiveSchema = UnitSchema | BooleanSchema | Int64Schema | Float64Schema | StringSchema | BytesSchema | InstantSchema;
export type Schema = PrimitiveSchema | ListSchema | TupleSchema | RecordSchema | VariantSchema | BrandSchema | RefSchema;

export function optionSchema(value: Schema): VariantSchema {
  return Object.freeze({ kind: 'variant', variants: Object.freeze([
    Object.freeze({ tag: 'none', schema: Object.freeze({ kind: 'unit' as const }) }),
    Object.freeze({ tag: 'some', schema: value }),
  ]) });
}

export function resultSchema(value: Schema, error: Schema): VariantSchema {
  return Object.freeze({ kind: 'variant', variants: Object.freeze([
    Object.freeze({ tag: 'ok', schema: value }),
    Object.freeze({ tag: 'error', schema: error }),
  ]) });
}

export interface TypeDefinition {
  readonly id: TypeId;
  readonly schema: Schema;
  readonly fingerprint: Sha256Digest;
}

export interface SchemaRegistry {
  readonly types: readonly TypeDefinition[];
}

export interface ValueLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

export interface CompileLimits {
  readonly sourceBytes: number;
  readonly moduleBytes: number;
  readonly modules: number;
  readonly imports: number;
  readonly declarations: number;
  readonly syntaxNodes: number;
  readonly syntaxDepth: number;
  readonly typeDepth: number;
  readonly typeInstantiationWork: number;
  readonly diagnostics: number;
  readonly derivedTemplateBytes: number;
}

export interface ExecutionLimits extends ValueLimits {
  readonly fuel: number;
  readonly allocations: number;
  readonly allocatedBytes: number;
  readonly retainedBytes: number;
  readonly collectionItems: number;
  readonly callDepth: number;
  readonly hostCalls: number;
  readonly concurrentActions: number;
  readonly traceBytes: number;
  readonly outputBytes: number;
}

export const STANDARD_VALUE_LIMITS: ValueLimits = Object.freeze({ maxDepth: 128, maxNodes: 250_000, maxBytes: 4 * 1024 * 1024 });
export const STANDARD_COMPILE_LIMITS: CompileLimits = Object.freeze({
  sourceBytes: 1024 * 1024,
  moduleBytes: 256 * 1024,
  modules: 128,
  imports: 1_024,
  declarations: 25_000,
  syntaxNodes: 500_000,
  syntaxDepth: 256,
  typeDepth: 128,
  typeInstantiationWork: 500_000,
  diagnostics: 100,
  derivedTemplateBytes: 1024 * 1024,
});
export const STANDARD_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  ...STANDARD_VALUE_LIMITS,
  fuel: 5_000_000,
  allocations: 100_000,
  allocatedBytes: 32 * 1024 * 1024,
  retainedBytes: 16 * 1024 * 1024,
  collectionItems: 100_000,
  callDepth: 128,
  hostCalls: 64,
  concurrentActions: 8,
  traceBytes: 256 * 1024,
  outputBytes: 4 * 1024 * 1024,
});

export type ValuePath = readonly (string | number)[];
export type ContractFailureCode =
  | 'invalid_schema'
  | 'invalid_value'
  | 'limit_exceeded'
  | 'malformed_cbor'
  | 'noncanonical_cbor'
  | 'schema_mismatch'
  | 'trailing_bytes'
  | 'unknown_type';

export interface ContractFailure {
  readonly code: ContractFailureCode;
  readonly path: ValuePath;
  readonly byteOffset?: number;
  readonly detail?: string;
}

export type ContractResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ContractFailure }>;

class CodecFault {
  constructor(readonly failure: ContractFailure) {}
}

function fail(code: ContractFailureCode, path: ValuePath, detail?: string, byteOffset?: number): never {
  const failure: ContractFailure = {
    code,
    path: Object.freeze([...path]),
    ...(byteOffset === undefined ? {} : { byteOffset }),
    ...(detail === undefined ? {} : { detail: detail.slice(0, 160) }),
  };
  throw new CodecFault(Object.freeze(failure));
}

function asFailure(error: unknown): ContractFailure {
  if (error instanceof CodecFault) return error.failure;
  return Object.freeze({ code: 'invalid_value', path: Object.freeze([]), detail: 'unexpected codec failure' });
}

function registryMap(registry?: SchemaRegistry): ReadonlyMap<TypeId, Schema> {
  return new Map(registry?.types.map((definition) => [definition.id, definition.schema] as const));
}

function resolved(schema: Schema, types: ReadonlyMap<TypeId, Schema>, path: ValuePath): Schema {
  const seen = new Set<TypeId>();
  let current = schema;
  while (current.kind === 'ref') {
    if (seen.has(current.type)) fail('invalid_schema', path, 'reference-only schema cycle');
    seen.add(current.type);
    const target = types.get(current.type);
    if (!target) fail('unknown_type', path);
    current = target;
  }
  return current;
}

function assertLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
}

function validateValueLimits(limits: ValueLimits): void {
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 0) fail('invalid_value', [], `invalid ${name}`);
}

export function defineSchemaRegistry(definitions: readonly TypeDefinition[]): SchemaRegistry {
  const idsSeen = new Set<TypeId>();
  for (const definition of definitions) {
    ids.type(definition.id);
    if (!SHA256.test(definition.fingerprint)) throw new TypeError(`invalid fingerprint for ${definition.id}`);
    if (idsSeen.has(definition.id)) throw new TypeError(`duplicate type ${definition.id}`);
    idsSeen.add(definition.id);
  }
  const visiting = new Set<object>();
  const visited = new Set<object>();
  const visit = (schema: Schema): void => {
    if (visited.has(schema)) return;
    if (visiting.has(schema)) throw new TypeError('schemas recurse through named references only');
    visiting.add(schema);
    if (schema.kind === 'ref' && !idsSeen.has(schema.type)) throw new TypeError(`unknown type ${schema.type}`);
    if (schema.kind === 'int64') {
      const minimum = schema.minimum ?? -(1n << 63n);
      const maximum = schema.maximum ?? (1n << 63n) - 1n;
      if (minimum < -(1n << 63n) || maximum > (1n << 63n) - 1n || minimum > maximum) throw new TypeError('invalid int64 range');
    } else if (schema.kind === 'float64') {
      const bounds = [schema.minimum, schema.maximum].filter((bound) => bound !== undefined);
      if (bounds.some((bound) => !Number.isFinite(bound) || Object.is(bound, -0)) || (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)) throw new TypeError('invalid float64 range');
    } else if (schema.kind === 'string' || schema.kind === 'bytes') {
      if (schema.maxBytes !== undefined) assertLimit(schema.maxBytes, 'maxBytes');
    } else if (schema.kind === 'instant') {
      if (schema.minimum) validateInstant(schema.minimum, { kind: 'instant' }, []);
      if (schema.maximum) validateInstant(schema.maximum, { kind: 'instant' }, []);
      if (schema.minimum && schema.maximum && compareInstant(schema.minimum, schema.maximum) > 0) throw new TypeError('invalid instant range');
    }
    if (schema.kind === 'list') {
      if (schema.maxItems !== undefined) assertLimit(schema.maxItems, 'maxItems');
      visit(schema.item);
    } else if (schema.kind === 'tuple') {
      schema.items.forEach(visit);
    } else if (schema.kind === 'record') {
      const names = new Set<string>();
      for (const field of schema.fields) {
        if (!FIELD_NAME.test(field.name) || names.has(field.name)) throw new TypeError('invalid or duplicate record field');
        names.add(field.name);
        visit(field.schema);
      }
    } else if (schema.kind === 'variant') {
      const tags = new Set<string>();
      for (const variant of schema.variants) {
        if (!VARIANT_TAG.test(variant.tag) || tags.has(variant.tag)) throw new TypeError('invalid or duplicate variant tag');
        tags.add(variant.tag);
        visit(variant.schema);
      }
    } else if (schema.kind === 'brand') {
      if (!idsSeen.has(schema.type)) throw new TypeError(`unknown brand type ${schema.type}`);
      visit(schema.base);
    }
    visiting.delete(schema);
    visited.add(schema);
  };
  definitions.forEach((definition) => visit(definition.schema));
  const schemas = new Map(definitions.map((definition) => [definition.id, definition.schema] as const));
  const inhabited = new Set<TypeId>();
  const canInhabit = (schema: Schema, checking = new Set<TypeId>()): boolean => {
    if (schema.kind === 'ref') {
      if (inhabited.has(schema.type) || checking.has(schema.type)) return inhabited.has(schema.type);
      checking.add(schema.type);
      const answer = canInhabit(schemas.get(schema.type) as Schema, checking);
      checking.delete(schema.type);
      return answer;
    }
    if (schema.kind === 'record') return schema.fields.every((field) => canInhabit(field.schema, new Set(checking)));
    if (schema.kind === 'tuple') return schema.items.every((item) => canInhabit(item, new Set(checking)));
    if (schema.kind === 'variant') return schema.variants.some((variant) => canInhabit(variant.schema, new Set(checking)));
    if (schema.kind === 'brand') return canInhabit(schema.base, checking);
    return true;
  };
  for (let pass = 0; pass < definitions.length; pass++) {
    for (const definition of definitions) if (canInhabit(definition.schema)) inhabited.add(definition.id);
  }
  const impossible = definitions.find((definition) => !inhabited.has(definition.id));
  if (impossible) throw new TypeError(`type has no finite inhabitant: ${impossible.id}`);
  return deepFreeze({ types: definitions.map((definition) => ({ ...definition })) }) as unknown as SchemaRegistry;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const scalar of value) {
    const code = scalar.codePointAt(0) as number;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function validUnicode(value: string, path: ValuePath, offset?: number): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_value', path, 'isolated surrogate', offset);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_value', path, 'isolated surrogate', offset);
    }
  }
}

function validPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(value: Record<string, unknown>, name: string, path: ValuePath): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('schema_mismatch', path, 'expected enumerable data property');
  return descriptor.value;
}

function validateDataArray(value: unknown[], path: ValuePath, ceiling: number): void {
  if (value.length > ceiling) fail('limit_exceeded', path, 'array length exceeds limit');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail('schema_mismatch', path, 'expected dense array data');
  for (let index = 0; index < value.length; index++) dataProperty(value as unknown as Record<string, unknown>, String(index), [...path, index]);
}

function compareInstant(left: InstantValue, right: InstantValue): number {
  return left.epochSeconds === right.epochSeconds ? left.nanoseconds - right.nanoseconds : left.epochSeconds < right.epochSeconds ? -1 : 1;
}

const TEMPORAL_MIN: InstantValue = { epochSeconds: -8_640_000_000_000n, nanoseconds: 0 };
const TEMPORAL_MAX: InstantValue = { epochSeconds: 8_640_000_000_000n, nanoseconds: 0 };

function validateInstant(value: unknown, schema: InstantSchema, path: ValuePath): asserts value is InstantValue {
  if (!validPlainRecord(value)) fail('schema_mismatch', path, 'expected instant');
  const epochSeconds = dataProperty(value, 'epochSeconds', [...path, 'epochSeconds']);
  const nanoseconds = dataProperty(value, 'nanoseconds', [...path, 'nanoseconds']);
  if (
    Object.keys(value).length !== 2 ||
    typeof epochSeconds !== 'bigint' ||
    typeof nanoseconds !== 'number' ||
    !Number.isInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds > 999_999_999
  ) fail('schema_mismatch', path, 'expected instant');
  const instant: InstantValue = { epochSeconds, nanoseconds };
  if (
    compareInstant(instant, TEMPORAL_MIN) < 0 ||
    compareInstant(instant, TEMPORAL_MAX) > 0 ||
    (schema.minimum && compareInstant(instant, schema.minimum) < 0) ||
    (schema.maximum && compareInstant(instant, schema.maximum) > 0)
  ) fail('invalid_value', path, 'instant out of range');
}

function header(major: number, argument: bigint): number[] {
  if (argument < 24n) return [(major << 5) | Number(argument)];
  if (argument <= 0xffn) return [(major << 5) | 24, Number(argument)];
  if (argument <= 0xffffn) return [(major << 5) | 25, Number(argument >> 8n), Number(argument & 0xffn)];
  const width = argument <= 0xffff_ffffn ? 4 : 8;
  const bytes = [(major << 5) | (width === 4 ? 26 : 27)];
  for (let shift = width * 8 - 8; shift >= 0; shift -= 8) bytes.push(Number((argument >> BigInt(shift)) & 0xffn));
  return bytes;
}

interface EncodeTask { readonly schema: Schema; readonly value: unknown; readonly path: ValuePath; readonly depth: number }

export function encodeCanonical(
  schema: Schema,
  value: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<Uint8Array> {
  try {
    const limits = options.limits ?? STANDARD_VALUE_LIMITS;
    validateValueLimits(limits);
    const types = registryMap(options.registry);
    if (schema.kind === 'ref' && schema.type === JSON_VALUE_TYPE) validateJsonObjectOrder(value, limits);
    const output: number[] = [];
    const tasks: EncodeTask[] = [{ schema, value, path: [], depth: 0 }];
    let nodes = 0;
    const append = (bytes: readonly number[] | Uint8Array, path: ValuePath): void => {
      if (output.length + bytes.length > limits.maxBytes) fail('limit_exceeded', path, 'maxBytes');
      for (const byte of bytes) output.push(byte);
    };
    while (tasks.length > 0) {
      const task = tasks.pop() as EncodeTask;
      const current = resolved(task.schema, types, task.path);
      if (task.depth > limits.maxDepth) fail('limit_exceeded', task.path, 'maxDepth');
      if (++nodes > limits.maxNodes) fail('limit_exceeded', task.path, 'maxNodes');
      switch (current.kind) {
        case 'unit':
          if (task.value !== null) fail('schema_mismatch', task.path, 'expected unit');
          append([0xf6], task.path);
          break;
        case 'boolean':
          if (typeof task.value !== 'boolean') fail('schema_mismatch', task.path, 'expected boolean');
          append([task.value ? 0xf5 : 0xf4], task.path);
          break;
        case 'int64': {
          const integer = task.value;
          if (typeof integer !== 'bigint' || integer < -(1n << 63n) || integer > (1n << 63n) - 1n) fail('schema_mismatch', task.path, 'expected int64');
          if ((current.minimum !== undefined && integer < current.minimum) || (current.maximum !== undefined && integer > current.maximum)) fail('invalid_value', task.path, 'int64 out of range');
          append(header(integer >= 0n ? 0 : 1, integer >= 0n ? integer : -1n - integer), task.path);
          break;
        }
        case 'float64': {
          const float = task.value;
          if (typeof float !== 'number' || !Number.isFinite(float)) fail('schema_mismatch', task.path, 'expected finite float64');
          if ((current.minimum !== undefined && float < current.minimum) || (current.maximum !== undefined && float > current.maximum)) fail('invalid_value', task.path, 'float64 out of range');
          const bytes = new Uint8Array(9);
          bytes[0] = 0xfb;
          new DataView(bytes.buffer).setFloat64(1, Object.is(float, -0) ? 0 : float);
          append(bytes, task.path);
          break;
        }
        case 'string': {
          if (typeof task.value !== 'string') fail('schema_mismatch', task.path, 'expected string');
          validUnicode(task.value, task.path);
          const length = utf8Length(task.value);
          if (current.maxBytes !== undefined && length > current.maxBytes) fail('limit_exceeded', task.path, 'string.maxBytes');
          const prefix = header(3, BigInt(length));
          if (output.length + prefix.length + length > limits.maxBytes) fail('limit_exceeded', task.path, 'maxBytes');
          const bytes = new TextEncoder().encode(task.value);
          append(prefix, task.path);
          append(bytes, task.path);
          break;
        }
        case 'bytes': {
          if (!Array.isArray(task.value)) fail('schema_mismatch', task.path, 'expected bytes');
          if (current.maxBytes !== undefined && task.value.length > current.maxBytes) fail('limit_exceeded', task.path, 'bytes.maxBytes');
          validateDataArray(task.value, task.path, limits.maxBytes - output.length);
          const byteValues: unknown[] = [];
          for (let index = 0; index < task.value.length; index++) byteValues.push(dataProperty(task.value as unknown as Record<string, unknown>, String(index), [...task.path, index]));
          if (!byteValues.every((byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255)) fail('schema_mismatch', task.path, 'expected bytes');
          append(header(2, BigInt(task.value.length)), task.path);
          append(byteValues as number[], task.path);
          break;
        }
        case 'instant':
          validateInstant(task.value, current, task.path);
          append(header(4, 2n), task.path);
          tasks.push({ schema: { kind: 'int64', minimum: 0n, maximum: 999_999_999n }, value: BigInt(dataProperty(task.value as unknown as Record<string, unknown>, 'nanoseconds', [...task.path, 'nanoseconds']) as number), path: [...task.path, 'nanoseconds'], depth: task.depth + 1 });
          tasks.push({ schema: { kind: 'int64' }, value: dataProperty(task.value as unknown as Record<string, unknown>, 'epochSeconds', [...task.path, 'epochSeconds']), path: [...task.path, 'epochSeconds'], depth: task.depth + 1 });
          break;
        case 'list': {
          if (!Array.isArray(task.value)) fail('schema_mismatch', task.path, 'expected list');
          if (current.maxItems !== undefined && task.value.length > current.maxItems) fail('limit_exceeded', task.path, 'list.maxItems');
          validateDataArray(task.value, task.path, limits.maxNodes - nodes);
          append(header(4, BigInt(task.value.length)), task.path);
          for (let index = task.value.length - 1; index >= 0; index--) tasks.push({ schema: current.item, value: dataProperty(task.value as unknown as Record<string, unknown>, String(index), [...task.path, index]), path: [...task.path, index], depth: task.depth + 1 });
          break;
        }
        case 'tuple':
          if (!Array.isArray(task.value) || task.value.length !== current.items.length) fail('schema_mismatch', task.path, 'wrong tuple length');
          validateDataArray(task.value, task.path, limits.maxNodes - nodes);
          append(header(4, BigInt(current.items.length)), task.path);
          for (let index = current.items.length - 1; index >= 0; index--) tasks.push({ schema: current.items[index] as Schema, value: dataProperty(task.value as unknown as Record<string, unknown>, String(index), [...task.path, index]), path: [...task.path, index], depth: task.depth + 1 });
          break;
        case 'record': {
          if (!validPlainRecord(task.value)) fail('schema_mismatch', task.path, 'expected record');
          const record = task.value;
          const names = current.fields.map((field) => field.name);
          if (Object.keys(record).length !== names.length || names.some((name) => !Object.hasOwn(record, name))) fail('schema_mismatch', task.path, 'record fields do not match schema');
          append(header(4, BigInt(names.length)), task.path);
          for (let index = current.fields.length - 1; index >= 0; index--) {
            const field = current.fields[index] as RecordField;
            tasks.push({ schema: field.schema, value: dataProperty(record, field.name, [...task.path, field.name]), path: [...task.path, field.name], depth: task.depth + 1 });
          }
          break;
        }
        case 'variant': {
          if (!validPlainRecord(task.value) || Object.keys(task.value).length !== 2 || !Object.hasOwn(task.value, 'tag') || !Object.hasOwn(task.value, 'value')) fail('schema_mismatch', task.path, 'expected variant');
          const value = task.value;
          const tag = dataProperty(value, 'tag', [...task.path, 'tag']);
          const payload = dataProperty(value, 'value', [...task.path, 'value']);
          if (typeof tag !== 'string') fail('schema_mismatch', [...task.path, 'tag'], 'expected variant tag');
          const variant = current.variants.find((candidate) => candidate.tag === tag);
          if (!variant) fail('schema_mismatch', [...task.path, 'tag'], 'unknown variant');
          append(header(4, 2n), task.path);
          tasks.push({ schema: variant.schema, value: payload, path: [...task.path, 'value'], depth: task.depth + 1 });
          tasks.push({ schema: { kind: 'string' }, value: variant.tag, path: [...task.path, 'tag'], depth: task.depth + 1 });
          break;
        }
        case 'brand':
          tasks.push({ ...task, schema: current.base });
          nodes--;
          break;
      }
    }
    return Object.freeze({ ok: true, value: Uint8Array.from(output) });
  } catch (error) {
    return Object.freeze({ ok: false, failure: asFailure(error) });
  }
}

type Assign = (value: CanonicalValue) => void;
interface DecodeTask { readonly kind: 'value'; readonly schema: Schema; readonly path: ValuePath; readonly depth: number; readonly assign: Assign }
interface VariantTask { readonly kind: 'variant'; readonly schema: VariantSchema; readonly path: ValuePath; readonly depth: number; readonly target: Record<string, CanonicalValue> }
type ParseTask = DecodeTask | VariantTask;

class Decoder {
  offset = 0;
  nodes = 0;
  readonly text = new TextDecoder('utf-8', { fatal: true });

  constructor(readonly bytes: Uint8Array, readonly limits: ValueLimits) {
    if (bytes.length > limits.maxBytes) fail('limit_exceeded', [], 'maxBytes', 0);
  }

  byte(path: ValuePath): number {
    if (this.offset >= this.bytes.length) fail('malformed_cbor', path, 'truncated input', this.offset);
    return this.bytes[this.offset++] as number;
  }

  argument(additional: number, path: ValuePath): bigint {
    if (additional < 24) return BigInt(additional);
    const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (width === 0) fail('malformed_cbor', path, 'indefinite or reserved encoding', this.offset - 1);
    let value = 0n;
    for (let index = 0; index < width; index++) value = (value << 8n) | BigInt(this.byte(path));
    const minimum = width === 1 ? 24n : width === 2 ? 256n : width === 4 ? 65_536n : 4_294_967_296n;
    if (value < minimum) fail('noncanonical_cbor', path, 'non-preferred argument', this.offset - width - 1);
    return value;
  }

  head(major: number, path: ValuePath): bigint {
    const start = this.offset;
    const initial = this.byte(path);
    if (initial >> 5 !== major) fail('schema_mismatch', path, `expected CBOR major type ${major}`, start);
    return this.argument(initial & 31, path);
  }

  length(major: number, path: ValuePath, ceiling: number): number {
    const length = this.head(major, path);
    if (length > BigInt(Number.MAX_SAFE_INTEGER) || length > BigInt(ceiling)) fail('limit_exceeded', path, 'declared length exceeds limit', this.offset);
    return Number(length);
  }

  string(path: ValuePath, maxBytes = this.limits.maxBytes): string {
    const length = this.length(3, path, Math.min(maxBytes, this.bytes.length - this.offset));
    const start = this.offset;
    const end = start + length;
    let value: string;
    try {
      value = this.text.decode(this.bytes.subarray(start, end));
    } catch {
      fail('malformed_cbor', path, 'invalid UTF-8', start);
    }
    this.offset = end;
    validUnicode(value, path, start);
    return value;
  }
}

export function decodeCanonical(
  schema: Schema,
  bytes: Uint8Array,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<CanonicalValue> {
  try {
    if (!(bytes instanceof Uint8Array)) fail('invalid_value', [], 'input must be Uint8Array');
    const limits = options.limits ?? STANDARD_VALUE_LIMITS;
    validateValueLimits(limits);
    const types = registryMap(options.registry);
    const decoder = new Decoder(bytes, limits);
    let root: CanonicalValue = null;
    const tasks: ParseTask[] = [{ kind: 'value', schema, path: [], depth: 0, assign: (value) => { root = value; } }];
    while (tasks.length > 0) {
      const task = tasks.pop() as ParseTask;
      if (task.kind === 'variant') {
        if (task.depth + 1 > limits.maxDepth) fail('limit_exceeded', [...task.path, 'tag'], 'maxDepth', decoder.offset);
        if (++decoder.nodes > limits.maxNodes) fail('limit_exceeded', [...task.path, 'tag'], 'maxNodes', decoder.offset);
        const tag = decoder.string([...task.path, 'tag']);
        const variant = task.schema.variants.find((candidate) => candidate.tag === tag);
        if (!variant) fail('schema_mismatch', [...task.path, 'tag'], 'unknown variant', decoder.offset);
        task.target.tag = tag;
        tasks.push({ kind: 'value', schema: variant.schema, path: [...task.path, 'value'], depth: task.depth + 1, assign: (value) => { task.target.value = value; } });
        continue;
      }
      const current = resolved(task.schema, types, task.path);
      if (task.depth > limits.maxDepth) fail('limit_exceeded', task.path, 'maxDepth', decoder.offset);
      if (++decoder.nodes > limits.maxNodes) fail('limit_exceeded', task.path, 'maxNodes', decoder.offset);
      switch (current.kind) {
        case 'unit':
          if (decoder.byte(task.path) !== 0xf6) fail('schema_mismatch', task.path, 'expected unit', decoder.offset - 1);
          task.assign(null);
          break;
        case 'boolean': {
          const byte = decoder.byte(task.path);
          if (byte !== 0xf4 && byte !== 0xf5) fail('schema_mismatch', task.path, 'expected boolean', decoder.offset - 1);
          task.assign(byte === 0xf5);
          break;
        }
        case 'int64': {
          const start = decoder.offset;
          const initial = decoder.byte(task.path);
          const major = initial >> 5;
          if (major !== 0 && major !== 1) fail('schema_mismatch', task.path, 'expected int64', start);
          const unsigned = decoder.argument(initial & 31, task.path);
          const integer = major === 0 ? unsigned : -1n - unsigned;
          if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n) fail('invalid_value', task.path, 'int64 out of range', start);
          if ((current.minimum !== undefined && integer < current.minimum) || (current.maximum !== undefined && integer > current.maximum)) fail('invalid_value', task.path, 'int64 out of range', start);
          task.assign(integer);
          break;
        }
        case 'float64': {
          const start = decoder.offset;
          if (decoder.byte(task.path) !== 0xfb) fail('noncanonical_cbor', task.path, 'float64 must use binary64', start);
          if (decoder.offset + 8 > bytes.length) fail('malformed_cbor', task.path, 'truncated float64', decoder.offset);
          const float = new DataView(bytes.buffer, bytes.byteOffset + decoder.offset, 8).getFloat64(0);
          decoder.offset += 8;
          if (!Number.isFinite(float) || Object.is(float, -0)) fail('noncanonical_cbor', task.path, 'invalid canonical float64', start);
          if ((current.minimum !== undefined && float < current.minimum) || (current.maximum !== undefined && float > current.maximum)) fail('invalid_value', task.path, 'float64 out of range', start);
          task.assign(float);
          break;
        }
        case 'string':
          task.assign(decoder.string(task.path, current.maxBytes));
          break;
        case 'bytes': {
          const length = decoder.length(2, task.path, Math.min(current.maxBytes ?? limits.maxBytes, bytes.length - decoder.offset));
          const end = decoder.offset + length;
          const value = Object.freeze(Array.from(bytes.subarray(decoder.offset, end)));
          decoder.offset = end;
          task.assign(value);
          break;
        }
        case 'instant': {
          if (decoder.head(4, task.path) !== 2n) fail('schema_mismatch', task.path, 'instant must have two fields', decoder.offset);
          const value: Record<string, CanonicalValue> = {};
          tasks.push({ kind: 'value', schema: { kind: 'int64', minimum: 0n, maximum: 999_999_999n }, path: [...task.path, 'nanoseconds'], depth: task.depth + 1, assign: (nanoseconds) => {
            value.nanoseconds = Number(nanoseconds);
            validateInstant(value, current, task.path);
            task.assign(Object.freeze(value) as unknown as InstantValue);
          } });
          tasks.push({ kind: 'value', schema: { kind: 'int64' }, path: [...task.path, 'epochSeconds'], depth: task.depth + 1, assign: (seconds) => { value.epochSeconds = seconds; } });
          break;
        }
        case 'list': {
          const ceiling = Math.min(current.maxItems ?? limits.maxNodes, limits.maxNodes - decoder.nodes);
          const length = decoder.length(4, task.path, ceiling);
          const value: CanonicalValue[] = new Array(length);
          task.assign(value);
          for (let index = length - 1; index >= 0; index--) tasks.push({ kind: 'value', schema: current.item, path: [...task.path, index], depth: task.depth + 1, assign: (item) => { value[index] = item; } });
          break;
        }
        case 'tuple': {
          if (decoder.head(4, task.path) !== BigInt(current.items.length)) fail('schema_mismatch', task.path, 'wrong tuple length', decoder.offset);
          const value: CanonicalValue[] = new Array(current.items.length);
          task.assign(value);
          for (let index = current.items.length - 1; index >= 0; index--) tasks.push({ kind: 'value', schema: current.items[index] as Schema, path: [...task.path, index], depth: task.depth + 1, assign: (item) => { value[index] = item; } });
          break;
        }
        case 'record': {
          if (decoder.head(4, task.path) !== BigInt(current.fields.length)) fail('schema_mismatch', task.path, 'wrong record field count', decoder.offset);
          const value: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
          task.assign(value);
          for (let index = current.fields.length - 1; index >= 0; index--) {
            const field = current.fields[index] as RecordField;
            tasks.push({ kind: 'value', schema: field.schema, path: [...task.path, field.name], depth: task.depth + 1, assign: (item) => { value[field.name] = item; } });
          }
          break;
        }
        case 'variant': {
          if (decoder.head(4, task.path) !== 2n) fail('schema_mismatch', task.path, 'variant must have two fields', decoder.offset);
          const value: Record<string, CanonicalValue> = {};
          task.assign(value);
          tasks.push({ kind: 'variant', schema: current, path: task.path, depth: task.depth, target: value });
          break;
        }
        case 'brand':
          tasks.push({ ...task, schema: current.base });
          decoder.nodes--;
          break;
      }
    }
    if (decoder.offset !== bytes.length) fail('trailing_bytes', [], 'trailing bytes', decoder.offset);
    if (schema.kind === 'ref' && schema.type === JSON_VALUE_TYPE) validateJsonObjectOrder(root, limits);
    return Object.freeze({ ok: true, value: deepFreeze(root) });
  } catch (error) {
    return Object.freeze({ ok: false, failure: asFailure(error) });
  }
}

export function canonicalize(
  schema: Schema,
  value: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<CanonicalValue> {
  const encoded = encodeCanonical(schema, value, options);
  return encoded.ok ? decodeCanonical(schema, encoded.value, options) : encoded;
}

export function canonicalEqual(
  schema: Schema,
  left: unknown,
  right: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<boolean> {
  const leftBytes = encodeCanonical(schema, left, options);
  if (!leftBytes.ok) return leftBytes;
  const rightBytes = encodeCanonical(schema, right, options);
  if (!rightBytes.ok) return rightBytes;
  return Object.freeze({ ok: true, value: leftBytes.value.length === rightBytes.value.length && leftBytes.value.every((byte, index) => byte === rightBytes.value[index]) });
}

export function digestCanonical(
  domain: HashDomain,
  schema: Schema,
  value: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<Sha256Digest> {
  const encoded = encodeCanonical(schema, value, options);
  return encoded.ok ? Object.freeze({ ok: true, value: hash(domain, encoded.value) }) : encoded;
}

export function deriveIdempotencyKey(input: Readonly<{
  seed: CanonicalBytes;
  contractId: ContractId;
  operationId: OperationId;
  actionSiteId: ActionSiteId;
  sequence: number;
  actionInput: CanonicalBytes;
}>): ContractResult<Sha256Digest> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    return Object.freeze({ ok: false, failure: Object.freeze({ code: 'invalid_value', path: Object.freeze(['sequence']), detail: 'invalid action sequence' }) });
  }
  const actionDigest = createHash('sha256').update(Uint8Array.from(input.actionInput)).digest('hex');
  return digestCanonical('idempotency', {
    kind: 'tuple',
    items: [{ kind: 'bytes' }, { kind: 'string' }, { kind: 'string' }, { kind: 'string' }, { kind: 'int64' }, { kind: 'string' }],
  }, [input.seed, input.contractId, input.operationId, input.actionSiteId, BigInt(input.sequence), actionDigest]);
}

interface JsonTask {
  readonly kind: 'value';
  readonly input: unknown;
  readonly path: ValuePath;
  readonly depth: number;
  readonly assign: (value: JsonValue) => void;
}

interface JsonExitTask { readonly kind: 'exit'; readonly input: object }

export function canonicalJson(input: unknown, limits: ValueLimits = STANDARD_VALUE_LIMITS): ContractResult<JsonValue> {
  try {
    let root: JsonValue = { tag: 'null', value: null };
    let nodes = 0;
    const active = new Set<object>();
    const tasks: (JsonTask | JsonExitTask)[] = [{ kind: 'value', input, path: [], depth: 0, assign: (value) => { root = value; } }];
    while (tasks.length > 0) {
      const task = tasks.pop() as JsonTask | JsonExitTask;
      if (task.kind === 'exit') {
        active.delete(task.input);
        continue;
      }
      if (task.depth > limits.maxDepth) fail('limit_exceeded', task.path, 'maxDepth');
      if (++nodes > limits.maxNodes) fail('limit_exceeded', task.path, 'maxNodes');
      if (task.input === null) task.assign({ tag: 'null', value: null });
      else if (typeof task.input === 'boolean') task.assign({ tag: 'boolean', value: task.input });
      else if (typeof task.input === 'number') {
        if (!Number.isFinite(task.input)) fail('invalid_value', task.path, 'JSON number must be finite');
        task.assign({ tag: 'number', value: Object.is(task.input, -0) ? 0 : task.input });
      } else if (typeof task.input === 'string') {
        validUnicode(task.input, task.path);
        if (utf8Length(task.input) > limits.maxBytes) fail('limit_exceeded', task.path, 'maxBytes');
        task.assign({ tag: 'string', value: task.input });
      } else if (Array.isArray(task.input)) {
        if (active.has(task.input)) fail('invalid_value', task.path, 'cyclic JSON value');
        validateDataArray(task.input, task.path, limits.maxNodes - nodes);
        active.add(task.input);
        const values: JsonValue[] = new Array(task.input.length);
        task.assign({ tag: 'array', value: values });
        tasks.push({ kind: 'exit', input: task.input });
        for (let index = task.input.length - 1; index >= 0; index--) tasks.push({ kind: 'value', input: dataProperty(task.input as unknown as Record<string, unknown>, String(index), [...task.path, index]), path: [...task.path, index], depth: task.depth + 1, assign: (value) => { values[index] = value; } });
      } else if (validPlainRecord(task.input)) {
        if (active.has(task.input)) fail('invalid_value', task.path, 'cyclic JSON value');
        const keys = Object.keys(task.input).sort(compareUtf8);
        if (keys.length > limits.maxNodes - nodes) fail('limit_exceeded', task.path, 'maxNodes');
        active.add(task.input);
        const entries: [string, JsonValue][] = new Array(keys.length);
        task.assign({ tag: 'object', value: entries });
        tasks.push({ kind: 'exit', input: task.input });
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index] as string;
          validUnicode(key, [...task.path, key]);
          tasks.push({ kind: 'value', input: dataProperty(task.input, key, [...task.path, key]), path: [...task.path, key], depth: task.depth + 1, assign: (value) => { entries[index] = [key, value]; } });
        }
      } else fail('schema_mismatch', task.path, 'value is not JSON');
    }
    return Object.freeze({ ok: true, value: deepFreeze(root) });
  } catch (error) {
    return Object.freeze({ ok: false, failure: asFailure(error) });
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index++) {
    const difference = (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function validateJsonObjectOrder(root: unknown, limits: ValueLimits): void {
  const pending: unknown[] = [root];
  let nodes = 0;
  while (pending.length > 0) {
    if (++nodes > limits.maxNodes) fail('limit_exceeded', [], 'maxNodes');
    const item = pending.pop();
    if (!validPlainRecord(item)) continue;
    const tag = dataProperty(item, 'tag', []);
    const value = dataProperty(item, 'value', []);
    if (tag === 'array' && Array.isArray(value)) {
      validateDataArray(value, [], limits.maxNodes - nodes);
      for (let index = 0; index < value.length; index++) pending.push(dataProperty(value as unknown as Record<string, unknown>, String(index), [index]));
    }
    if (tag !== 'object' || !Array.isArray(value)) continue;
    validateDataArray(value, [], limits.maxNodes - nodes);
    let previous: string | undefined;
    for (let index = 0; index < value.length; index++) {
      const entry = dataProperty(value as unknown as Record<string, unknown>, String(index), [index]);
      if (!Array.isArray(entry)) continue;
      validateDataArray(entry, [index], 2);
      const key = dataProperty(entry as unknown as Record<string, unknown>, '0', [index, 0]);
      if (typeof key !== 'string') continue;
      if (previous !== undefined && compareUtf8(previous, key) >= 0) fail('invalid_value', [], 'JSON object keys are not strictly sorted');
      previous = key;
      pending.push(dataProperty(entry as unknown as Record<string, unknown>, '1', [index, 1]));
    }
  }
}

export const JSON_VALUE_TYPE = ids.type('type:safescript.json-value');
const JSON_VALUE_REF: RefSchema = Object.freeze({ kind: 'ref', type: JSON_VALUE_TYPE });
const JSON_VALUE_SCHEMA: VariantSchema = {
  kind: 'variant',
  variants: [
    { tag: 'null', schema: { kind: 'unit' } },
    { tag: 'boolean', schema: { kind: 'boolean' } },
    { tag: 'number', schema: { kind: 'float64' } },
    { tag: 'string', schema: { kind: 'string' } },
    { tag: 'array', schema: { kind: 'list', item: JSON_VALUE_REF } },
    { tag: 'object', schema: { kind: 'list', item: { kind: 'tuple', items: [{ kind: 'string' }, JSON_VALUE_REF] } } },
  ],
};
export const JSON_VALUE_REGISTRY = defineSchemaRegistry([{
  id: JSON_VALUE_TYPE,
  schema: JSON_VALUE_SCHEMA,
  fingerprint: hash('type', new TextEncoder().encode('safescript.json-value.v1')),
}]);

function deepFreeze<T>(root: T): T {
  if (root === null || typeof root !== 'object') return root;
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  return root;
}

export interface SourceLocation {
  readonly module: ModuleId;
  readonly start: number;
  readonly end: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly location?: SourceLocation;
  readonly related?: readonly SourceLocation[];
}

export interface BridgeError {
  readonly code: 'bridge_closed' | 'invalid_request' | 'unsupported_version' | 'adapter_failure' | 'unavailable';
  readonly phase: 'check' | 'inspect' | 'execute' | 'cancel' | 'close' | 'action';
  readonly detail?: string;
}

export interface PolicyError { readonly code: string; readonly detail?: string }
export type HostFailureCode = 'cancelled' | 'timeout' | 'unavailable' | 'handler_fault' | 'invalid_result' | 'transport_lost' | 'gateway_fault';
export interface HostFailure { readonly code: HostFailureCode; readonly detail?: string }
export type EffectState = 'not_performed' | 'unknown';

export interface SourceProvenance { readonly module: ModuleId; readonly start: number; readonly end: number }

export interface ActionRequest {
  readonly abiVersion: Version;
  readonly contractId: ContractId;
  readonly requiredContractVersion: SemVer;
  readonly irDigest: IrDigest;
  readonly invocationId: InvocationId;
  readonly requestId: RequestId;
  readonly slotId: SlotId;
  readonly operationId: OperationId;
  readonly effectId: EffectId;
  readonly capabilityId: CapabilityId;
  readonly actionSiteId: ActionSiteId;
  readonly source: SourceProvenance;
  readonly input: CanonicalBytes;
  readonly idempotencyKey?: Sha256Digest;
}

export type ActionOutcome = Readonly<{
  abiVersion: Version;
  requestId: RequestId;
  result:
    | Readonly<{ tag: 'completed'; value: CanonicalBytes }>
    | Readonly<{ tag: 'rejected'; value: PolicyError }>
    | Readonly<{ tag: 'failed'; value: Readonly<{ effectState: EffectState; failure: HostFailure }> }>;
}>;

export type ActionRecord = Readonly<{ phase: 'requested'; request: ActionRequest }> | Readonly<{ phase: 'resolved'; requestId: RequestId; outcome: ActionOutcome }>;

export interface DefinitionFingerprint { readonly id: ContractOwnedId; readonly fingerprint: Sha256Digest }
export interface EffectDefinition { readonly id: EffectId; readonly fingerprint: Sha256Digest }
export interface CapabilityDefinition { readonly id: CapabilityId; readonly fingerprint: Sha256Digest }
export interface OperationDefinition {
  readonly id: OperationId;
  readonly input: TypeId;
  readonly output: TypeId;
  readonly error: TypeId;
  readonly effect: EffectId;
  readonly capability: CapabilityId;
  readonly effectCost: number;
  readonly idempotency: 'none' | 'required';
  readonly fingerprint: Sha256Digest;
}
export interface SlotDefinition {
  readonly id: SlotId;
  readonly input: TypeId;
  readonly output: TypeId;
  readonly languageVersion: Version;
  readonly effects: readonly EffectId[];
  readonly capabilities: readonly CapabilityId[];
  readonly compileLimits: CompileLimits;
  readonly executionLimits: ExecutionLimits;
  readonly fingerprint: Sha256Digest;
}
export interface ContractRegistry {
  readonly id: ContractId;
  readonly version: SemVer;
  readonly digest: Sha256Digest;
  readonly schemas: SchemaRegistry;
  readonly effects: readonly EffectDefinition[];
  readonly capabilities: readonly CapabilityDefinition[];
  readonly operations: readonly OperationDefinition[];
  readonly slots: readonly SlotDefinition[];
  readonly definitions: readonly DefinitionFingerprint[];
}

export interface DefinitionCompatibilityFailure {
  readonly code: 'invalid_contract_digest' | 'invalid_definition_id' | 'missing_definition' | 'fingerprint_mismatch';
  readonly id?: ContractOwnedId;
}

export function checkDefinitionCompatibility(
  registry: ContractRegistry,
  required: readonly DefinitionFingerprint[],
): readonly DefinitionCompatibilityFailure[] {
  const failures: DefinitionCompatibilityFailure[] = [];
  if (!SHA256.test(registry.digest)) failures.push({ code: 'invalid_contract_digest' });
  const current = new Map(registry.definitions.map((definition) => [definition.id, definition.fingerprint] as const));
  for (const definition of required) {
    const [prefix, name] = String(definition.id).split(':', 2);
    if (!['type', 'effect', 'capability', 'operation', 'slot'].includes(prefix ?? '') || !HOST_NAME.test(name ?? '')) {
      failures.push({ code: 'invalid_definition_id', id: definition.id });
    } else if (!current.has(definition.id)) {
      failures.push({ code: 'missing_definition', id: definition.id });
    } else if (!SHA256.test(definition.fingerprint) || current.get(definition.id) !== definition.fingerprint) {
      failures.push({ code: 'fingerprint_mismatch', id: definition.id });
    }
  }
  return Object.freeze(failures.map((failure) => Object.freeze(failure)));
}

export interface SourceModule { readonly id: ModuleId; readonly source: CanonicalBytes }
export interface SourceProgram { readonly entry: ModuleId; readonly modules: readonly SourceModule[] }

export function programHash(program: SourceProgram): ContractResult<ProgramHash> {
  const modules = [...program.modules].sort((left, right) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0);
  if (!modules.some((module) => module.id === program.entry) || modules.some((module, index) => index > 0 && module.id === modules[index - 1]?.id)) {
    return Object.freeze({ ok: false, failure: Object.freeze({ code: 'invalid_value', path: Object.freeze([]), detail: 'invalid program module set' }) });
  }
  const schema: Schema = {
    kind: 'tuple',
    items: [
      { kind: 'string' },
      { kind: 'list', item: { kind: 'tuple', items: [{ kind: 'string' }, { kind: 'string' }] } },
    ],
  };
  const digest = digestCanonical('program', schema, [program.entry, modules.map((module) => [module.id, sourceHash(Uint8Array.from(module.source))])]);
  return digest.ok ? Object.freeze({ ok: true, value: digest.value as unknown as ProgramHash }) : digest;
}
export interface CheckedArtifactHeader {
  readonly languageVersion: Version;
  readonly compilerVersion: CompilerVersion;
  readonly contractId: ContractId;
  readonly requiredContractVersion: SemVer;
  readonly contractDigest: Sha256Digest;
  readonly referencedDefinitions: readonly DefinitionFingerprint[];
  readonly irVersion: Version;
  readonly abiVersion: Version;
  readonly sourceHash: SourceHash;
  readonly programHash: ProgramHash;
  readonly irDigest: IrDigest;
}

export interface CompileUsage { readonly sourceBytes: number; readonly syntaxNodes: number; readonly typeWork: number }
export interface ExecutionUsage { readonly fuel: number; readonly allocations: number; readonly allocatedBytes: number; readonly peakRetainedBytes: number; readonly hostCalls: number; readonly traceBytes: number; readonly outputBytes: number }
export interface ProgramSummary { readonly effects: readonly EffectId[]; readonly capabilities: readonly CapabilityId[] }
export interface CompilerProvenance { readonly compiler: CompilerVersion; readonly language: Version; readonly ir: Version; readonly abi: Version }

export interface CheckRequest {
  readonly abiVersion: Version;
  readonly languageVersion: Version;
  readonly registry: ContractRegistry;
  readonly slotId: SlotId;
  readonly source: SourceProgram;
  readonly limits: CompileLimits;
}

export type CheckResult =
  | Readonly<{ status: 'accepted'; artifact: CanonicalBytes; summary: ProgramSummary; provenance: CompilerProvenance; usage: CompileUsage; diagnostics: readonly Diagnostic[] }>
  | Readonly<{ status: 'rejected'; diagnostics: readonly Diagnostic[]; usage: CompileUsage }>
  | Readonly<{ status: 'bridge_error'; error: BridgeError }>;

export type InspectView = 'semantic_graph';
export interface InspectRequest extends CheckRequest { readonly views: readonly InspectView[] }
export type InspectResult =
  | Readonly<{ status: 'accepted'; check: Extract<CheckResult, { status: 'accepted' }>; views: Readonly<Partial<Record<InspectView, CanonicalBytes>>> }>
  | Extract<CheckResult, { status: 'rejected' | 'bridge_error' }>;

export type TraceMode = 'none' | 'summary' | 'semantic';
export type ExecutableProgram = Readonly<{ kind: 'source'; source: CheckRequest }> | Readonly<{ kind: 'artifact'; bytes: CanonicalBytes }>;
export interface ExecuteRequest {
  readonly abiVersion: Version;
  readonly registry: ContractRegistry;
  readonly slotId: SlotId;
  readonly invocationId: InvocationId;
  readonly program: ExecutableProgram;
  readonly input: CanonicalBytes;
  readonly limits: ExecutionLimits;
  readonly idempotencySeed?: CanonicalBytes;
  readonly fixedInstant?: InstantValue;
  readonly randomSeed?: CanonicalBytes;
  readonly trace: TraceMode;
}

export interface TraceResult { readonly records: readonly CanonicalBytes[]; readonly truncated: boolean }
export interface ExecutionFacts { readonly actions: readonly ActionRecord[]; readonly trace: TraceResult; readonly usage: ExecutionUsage }
export interface ExecutionError { readonly code: string; readonly detail?: string }
export type ExecutionResult =
  | Readonly<{ status: 'not_started'; diagnostics?: readonly Diagnostic[]; error?: BridgeError; usage?: CompileUsage }>
  | Readonly<{ status: 'completed'; output: CanonicalBytes; facts: ExecutionFacts }>
  | Readonly<{ status: 'failed'; error: ExecutionError; facts: ExecutionFacts }>
  | Readonly<{ status: 'cancelled'; error: ExecutionError; facts: ExecutionFacts }>
  | Readonly<{ status: 'bridge_error'; error: BridgeError }>;

export interface CancelRequest { readonly abiVersion: Version; readonly invocationId: InvocationId }
export interface CancelResult { readonly status: 'accepted' | 'not_active' | 'bridge_error'; readonly error?: BridgeError }
export interface CloseResult { readonly status: 'closed' | 'bridge_error'; readonly error?: BridgeError }

export interface RuntimeBridgeHost {
  handleAction(request: ActionRequest): Promise<ActionOutcome>;
}

export interface RuntimeBridge {
  check(request: CheckRequest): Promise<CheckResult>;
  inspect(request: InspectRequest): Promise<InspectResult>;
  execute(request: ExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult>;
  cancel(request: CancelRequest): Promise<CancelResult>;
  close(): Promise<CloseResult>;
}

export type RuntimeBridgeFactory = () => RuntimeBridge;
