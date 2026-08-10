/**
 * Transport-neutral contracts, canonical codecs, stable identities, and runtime bridge records shared by all
 * SafeScript implementations.
 *
 * @remarks Values exported here must remain immutable and language-neutral. Do not add JavaScript closures, object
 * identity, host handles, credentials, or implementation exceptions to these interfaces.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

declare const brand: unique symbol;

/** Adds a compile-time nominal identity without changing a value's serialised representation. */
export type Branded<T, Name extends string> = T & { readonly [brand]: Name };

/** Stable identity of one host-owned contract. */
export type ContractId = Branded<string, 'ContractId'>;
/** Stable identity of one schema declared by a host contract. */
export type TypeId = Branded<string, 'TypeId'>;
/** Stable identity used to route an action request to a host handler. */
export type OperationId = Branded<string, 'OperationId'>;
/** Stable identity of a host-defined extension entry point. */
export type SlotId = Branded<string, 'SlotId'>;
/** Stable identity of a complete source module supplied in a compile request. */
export type ModuleId = Branded<string, 'ModuleId'>;
/** Reproducible identity of a source declaration. */
export type SymbolId = Branded<string, 'SymbolId'>;
/** Reproducible identity of a checked host-call site. */
export type ActionSiteId = Branded<string, 'ActionSiteId'>;
/** Opaque identity correlating one live execution and its actions. */
export type InvocationId = Branded<string, 'InvocationId'>;
/** Identity of one action attempt within an invocation; it is not an idempotency key. */
export type RequestId = Branded<string, 'RequestId'>;
/** Lowercase full-length SHA-256 digest. */
export type Sha256Digest = Branded<string, 'Sha256Digest'>;
/** Digest of canonical source bytes. */
export type SourceHash = Branded<string, 'SourceHash'>;
/** Digest of a canonically ordered complete source program. */
export type ProgramHash = Branded<string, 'ProgramHash'>;
/** Digest of verified typed IR. */
export type IrDigest = Branded<string, 'IrDigest'>;
/** Reproducible identity of one fact in a derived semantic graph. */
export type SemanticNodeId = Branded<string, 'SemanticNodeId'>;

const HOST_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const MODULE_NAME = /^@?[a-z][a-z0-9-]*(?:[/.][a-z][a-z0-9-]*)*$/;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VARIANT_TAG = /^[a-z][a-z0-9_-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INVOCATION = /^[0-9a-f]{32}$/;
const MAX_ID_NAME_BYTES = 128;

type ContractOwnedId = TypeId | OperationId | SlotId;
type IdPrefix = 'contract' | 'type' | 'operation' | 'slot' | 'module';

function parseNamedId<Id extends string>(prefix: IdPrefix, value: string): Id {
  const expected = `${prefix}:`;
  const name = value.startsWith(expected) ? value.slice(expected.length) : '';
  const validName = prefix === 'module' ? MODULE_NAME.test(name) : HOST_NAME.test(name);
  if (!validName || utf8Length(name) > MAX_ID_NAME_BYTES) {
    throw new TypeError(`invalid ${prefix} identifier`);
  }
  return value as Id;
}

/**
 * Validates and brands every stable identifier crossing a public seam.
 *
 * @remarks Contract-owned names are deliberately ASCII and length-bounded so every host language compares the same
 * bytes. Invocation and request identities use closed formats for reliable correlation.
 */
export const ids = Object.freeze({
  contract: (value: string): ContractId => parseNamedId('contract', value),
  type: (value: string): TypeId => parseNamedId('type', value),
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

/** Domain separators supported by {@link hash}. */
export type HashDomain =
  'action-site' | 'artifact' | 'contract' | 'ir' | 'program' | 'semantic-node' | 'source' | 'symbol' | 'type';

/**
 * Computes a versioned, domain-separated SHA-256 digest.
 *
 * @param domain - Semantic domain that prevents identical bytes from sharing meaning across uses.
 * @param bytes - Exact canonical bytes to digest.
 */
export function hash(domain: HashDomain, bytes: Uint8Array): Sha256Digest {
  return createHash('sha256').update(`safescript:${domain}:v1\0`, 'utf8').update(bytes).digest('hex') as Sha256Digest;
}

/** Derives a reproducible declaration identity from canonical semantic bytes. */
export function derivedSymbolId(bytes: Uint8Array): SymbolId {
  return ids.symbol(`symbol:${hash('symbol', bytes)}`);
}

/** Derives a reproducible host-call-site identity from canonical semantic bytes. */
export function derivedActionSiteId(bytes: Uint8Array): ActionSiteId {
  return ids.actionSite(`action-site:${hash('action-site', bytes)}`);
}

/** Derives a formatting-insensitive identity for one source-semantic graph fact. */
export function derivedSemanticNodeId(bytes: Uint8Array): SemanticNodeId {
  return `semantic-node:${hash('semantic-node', bytes)}` as SemanticNodeId;
}

/** Computes the canonical hash of one source byte sequence. */
export function sourceHash(bytes: Uint8Array): SourceHash {
  return hash('source', bytes) as unknown as SourceHash;
}

/** Major/minor numeric pair used by internal structured formats. */
export interface Version {
  readonly major: number;
  readonly minor: number;
}

/** Full semantic version used by versioned generated records. */
export interface SemVer extends Version {
  readonly patch: number;
  readonly prerelease?: string;
}

/** Serialisable authoring rules shared by checking and generated authoring bundles. */
export interface LanguageProfile {
  readonly name: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly authoringRules: readonly string[];
}

const CORE_LANGUAGE_PROFILE: LanguageProfile = {
  name: 'SafeScript restricted TypeScript',
  accepted: [
    'named static imports and one named exported async handler',
    'readonly records, tagged unions, const bindings, if, exhaustive switch, and return',
    'short-circuit boolean logic, same-type comparisons, bounded templates, and one sequential host action',
  ],
  rejected: [
    'ambient file, network, process, package, environment, or credential access',
    'mutation, unsafe types or assertions, exceptions, dynamic imports, generated code, loops, and recursion',
    'floating promises, timers, callbacks, concurrency, reflection, prototypes, classes, and regular expressions',
  ],
  authoringRules: [
    'Submit exactly one named exported async handler with typed event and Context parameters.',
    'Import host values and types from host:api and Result, Ok, and Err from safescript:prelude.',
    'Call host operations only through direct ctx paths and await every action exactly once.',
    'Use immutable values and handle every Result tag; host policy remains outside the source program.',
  ],
};

const CURRENT_LANGUAGE_PROFILE: LanguageProfile = {
  name: 'SafeScript restricted TypeScript',
  accepted: [
    ...CORE_LANGUAGE_PROFILE.accepted,
    'typed helper functions, closures, restricted generics, bounded loops, recursion, readonly arrays and tuples',
    'deterministic String, Bytes, Math, Temporal, JSON, console trace, and immutable collection operations',
    'multiple sequential actions consumed directly by await',
  ],
  rejected: [
    'ambient file, network, process, package, environment, or credential access',
    'any, unchecked assertions, exceptions, dynamic imports, generated code, mutable objects, and mutable module state',
    'floating or duplicated actions, promise concurrency, timers, reflection, prototypes, classes, regex, Map, and Set',
  ],
  authoringRules: [
    ...CORE_LANGUAGE_PROFILE.authoringRules,
    'Keep loops, recursion, collections, strings, JSON, traces, and host calls within slot limits.',
    'Use deterministic intrinsics; time and randomness come only from invocation-provided Temporal.Now and Math.random.',
    'JSON.parse<T> returns a checked Result; handle both tags before using the decoded value.',
    'After checking a host Result error, keep later code independent of the original result payload unless bound in that branch.',
    'Trace Instant and other typed deterministic values directly; do not rely on ambient or prototype conversion.',
  ],
};

/** The sole language profile implemented by this SafeScript release. */
export const LANGUAGE_PROFILE: LanguageProfile = deepFreeze(CURRENT_LANGUAGE_PROFILE);

/** Returns the current SafeScript language profile. */
export function languageProfile(): LanguageProfile {
  return LANGUAGE_PROFILE;
}

/** Exact compiler release and build that produced an artifact. */
export interface CompilerVersion {
  readonly build: string;
}

/** Immutable language-neutral byte representation used at serialisable seams. */
export type CanonicalBytes = readonly number[];

/** Nanosecond-precision instant with an explicit integer epoch representation. */
export interface InstantValue {
  readonly epochSeconds: bigint;
  readonly nanoseconds: number;
}

/** Canonical unit value. */
export type UnitValue = null;
/** Explicit optional value; absence is never represented by JavaScript `undefined`. */
export type Option<T> = Readonly<{ tag: 'none'; value: UnitValue }> | Readonly<{ tag: 'some'; value: T }>;
/** Explicit typed success or declared error value. */
export type Result<T, E> = Readonly<{ tag: 'ok'; value: T }> | Readonly<{ tag: 'error'; value: E }>;
/** Runtime representation of a closed schema variant. */
export interface VariantValue {
  readonly tag: string;
  readonly value: CanonicalValue;
}
/** Runtime representation of a schema-declared immutable record. */
export interface RecordValue {
  readonly [key: string]: CanonicalValue;
}
/**
 * Values permitted inside SafeScript and across its ABI.
 *
 * @remarks This union deliberately excludes `undefined`, functions, symbols, class instances, mutable handles, and
 * cyclic object graphs.
 */
export type CanonicalValue =
  | UnitValue
  | boolean
  | bigint
  | number
  | string
  | CanonicalBytes
  | InstantValue
  | readonly CanonicalValue[]
  | RecordValue
  | VariantValue;

/** Bounded tagged representation of JSON when no closed host schema is available. */
export type JsonValue =
  | Readonly<{ tag: 'null'; value: UnitValue }>
  | Readonly<{ tag: 'boolean'; value: boolean }>
  | Readonly<{ tag: 'number'; value: number }>
  | Readonly<{ tag: 'string'; value: string }>
  | Readonly<{ tag: 'array'; value: readonly JsonValue[] }>
  | Readonly<{ tag: 'object'; value: readonly (readonly [string, JsonValue])[] }>;

/** Schema for {@link UnitValue}. */
export interface UnitSchema {
  readonly kind: 'unit';
}
/** Schema for a canonical boolean. */
export interface BooleanSchema {
  readonly kind: 'boolean';
}
/** Schema for a signed 64-bit integer represented as `bigint`. */
export interface Int64Schema {
  readonly kind: 'int64';
  readonly minimum?: bigint;
  readonly maximum?: bigint;
}
/** Schema for a finite IEEE-754 double. */
export interface Float64Schema {
  readonly kind: 'float64';
  readonly minimum?: number;
  readonly maximum?: number;
}
/** UTF-8 string schema with an optional encoded-byte ceiling. */
export interface StringSchema {
  readonly kind: 'string';
  readonly maxBytes?: number;
}
/** Byte-string schema with an optional length ceiling. */
export interface BytesSchema {
  readonly kind: 'bytes';
  readonly maxBytes?: number;
}
/** Instant schema with optional inclusive bounds. */
export interface InstantSchema {
  readonly kind: 'instant';
  readonly minimum?: InstantValue;
  readonly maximum?: InstantValue;
}
/** Homogeneous immutable list schema with an optional item ceiling. */
export interface ListSchema {
  readonly kind: 'list';
  readonly item: Schema;
  readonly maxItems?: number;
}
/** Fixed-length heterogeneous tuple schema. */
export interface TupleSchema {
  readonly kind: 'tuple';
  readonly items: readonly Schema[];
}
/** Named field in a closed record schema. */
export interface RecordField {
  readonly name: string;
  readonly schema: Schema;
}
/** Closed record schema; unknown or missing fields fail validation. */
export interface RecordSchema {
  readonly kind: 'record';
  readonly fields: readonly RecordField[];
}
/** One case in a closed discriminated union. */
export interface VariantCase {
  readonly tag: string;
  readonly schema: Schema;
}
/** Closed discriminated-union schema represented by `{ tag, value }`. */
export interface VariantSchema {
  readonly kind: 'variant';
  readonly variants: readonly VariantCase[];
}
/** Nominal type layered over a canonical primitive without adding a runtime wrapper. */
export interface BrandSchema {
  readonly kind: 'brand';
  readonly type: TypeId;
  readonly base: PrimitiveSchema;
}
/** Reference to a named schema in the active {@link SchemaRegistry}. */
export interface RefSchema {
  readonly kind: 'ref';
  readonly type: TypeId;
}

/** Schema kinds with no nested canonical values. */
export type PrimitiveSchema =
  UnitSchema | BooleanSchema | Int64Schema | Float64Schema | StringSchema | BytesSchema | InstantSchema;
/** Closed schema language accepted by canonical codecs and the compiler. */
export type Schema =
  PrimitiveSchema | ListSchema | TupleSchema | RecordSchema | VariantSchema | BrandSchema | RefSchema;

/** Creates the standard `none | some` optional-value schema. */
export function optionSchema(value: Schema): VariantSchema {
  return Object.freeze({
    kind: 'variant',
    variants: Object.freeze([
      Object.freeze({ tag: 'none', schema: Object.freeze({ kind: 'unit' as const }) }),
      Object.freeze({ tag: 'some', schema: value }),
    ]),
  });
}

/** Creates the standard `ok | error` result schema. */
export function resultSchema(value: Schema, error: Schema): VariantSchema {
  return Object.freeze({
    kind: 'variant',
    variants: Object.freeze([
      Object.freeze({ tag: 'ok', schema: value }),
      Object.freeze({ tag: 'error', schema: error }),
    ]),
  });
}

/** Named schema and its structural fingerprint in a host contract. */
export interface TypeDefinition {
  readonly id: TypeId;
  readonly schema: Schema;
  readonly fingerprint: Sha256Digest;
}

/** Immutable set of named schemas used to resolve {@link RefSchema} values. */
export interface SchemaRegistry {
  readonly types: readonly TypeDefinition[];
}

/** Structural and encoded-size ceilings applied while validating one canonical value. */
export interface ValueLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/** Deterministic controls for source ingestion, parsing, and source diagnostics. */
export interface CompileLimits {
  readonly sourceBytes: number;
  readonly imports: number;
  readonly declarations: number;
  readonly syntaxNodes: number;
  readonly syntaxDepth: number;
  readonly typeDepth: number;
  /** Whether a rejected check includes its single source diagnostic. */
  readonly includeDiagnostics: boolean;
  readonly derivedTemplateBytes: number;
}

/** Semantic execution ceilings enforced independently of JavaScript engine resource use. */
export interface ExecutionLimits extends ValueLimits {
  readonly fuel: number;
  readonly allocations: number;
  /** Total canonical bytes allocated during the invocation; values are never credited as released. */
  readonly allocatedBytes: number;
  readonly collectionItems: number;
  readonly callDepth: number;
  readonly hostCalls: number;
  readonly traceBytes: number;
  readonly outputBytes: number;
}

/** Conservative default value ceilings; hosts and slots may only lower them. */
export const STANDARD_VALUE_LIMITS: ValueLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 32_768,
  maxBytes: 1024 * 1024,
});
/** Conservative default compiler ceilings; hosts and requests may only lower them. */
export const STANDARD_COMPILE_LIMITS: CompileLimits = Object.freeze({
  sourceBytes: 1024 * 1024,
  imports: 1_024,
  declarations: 25_000,
  syntaxNodes: 500_000,
  syntaxDepth: 256,
  typeDepth: 128,
  includeDiagnostics: true,
  derivedTemplateBytes: 1024 * 1024,
});
/** Conservative default execution ceilings; hosts and requests may only lower them. */
export const STANDARD_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  ...STANDARD_VALUE_LIMITS,
  fuel: 100_000,
  allocations: 10_000,
  allocatedBytes: 4 * 1024 * 1024,
  collectionItems: 10_000,
  callDepth: 64,
  hostCalls: 32,
  traceBytes: 128 * 1024,
  outputBytes: 1024 * 1024,
});

/** Stable field/index path locating a canonical-value validation failure. */
export type ValuePath = readonly (string | number)[];
/** Maximum number of path segments retained in a public validation failure. */
export const MAX_FAILURE_PATH_SEGMENTS = 64;
/** Maximum UTF-16 code units retained in a public safe-detail field. */
export const MAX_FAILURE_DETAIL_LENGTH = 160;
/** Maximum UTF-16 code units retained in non-normative diagnostic message text. */
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 320;
/** Maximum related source locations retained on one diagnostic. */
export const MAX_DIAGNOSTIC_RELATED_LOCATIONS = 16;
/** Closed machine-readable failure codes returned by canonical contract operations. */
export type ContractFailureCode =
  | 'invalid_schema'
  | 'invalid_value'
  | 'limit_exceeded'
  | 'malformed_cbor'
  | 'noncanonical_cbor'
  | 'schema_mismatch'
  | 'trailing_bytes'
  | 'unknown_type';

/** Bounded validation failure that is safe to cross a runtime bridge. */
export interface ContractFailure {
  readonly code: ContractFailureCode;
  readonly path: ValuePath;
  readonly byteOffset?: number;
  readonly detail?: string;
}

/** Non-throwing result returned by canonical codecs and digest helpers. */
export type ContractResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ContractFailure }>;

class CodecFault {
  constructor(readonly failure: ContractFailure) {}
}

function fail(code: ContractFailureCode, path: ValuePath, detail?: string, byteOffset?: number): never {
  const failure: ContractFailure = {
    code,
    path: Object.freeze(path.slice(0, MAX_FAILURE_PATH_SEGMENTS)),
    ...(byteOffset === undefined ? {} : { byteOffset }),
    ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_FAILURE_DETAIL_LENGTH) }),
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
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_value', [], `invalid ${name}`);
}

/**
 * Validates, recursively closes, sorts, and freezes named schema definitions.
 *
 * @throws TypeError if identifiers collide, references are missing, bounds are invalid, or recursion has no finite
 * inhabitant.
 */
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
      if (minimum < -(1n << 63n) || maximum > (1n << 63n) - 1n || minimum > maximum)
        throw new TypeError('invalid int64 range');
    } else if (schema.kind === 'float64') {
      const bounds = [schema.minimum, schema.maximum].filter((bound) => bound !== undefined);
      if (
        bounds.some((bound) => !Number.isFinite(bound) || Object.is(bound, -0)) ||
        (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)
      )
        throw new TypeError('invalid float64 range');
    } else if (schema.kind === 'string' || schema.kind === 'bytes') {
      if (schema.maxBytes !== undefined) assertLimit(schema.maxBytes, 'maxBytes');
    } else if (schema.kind === 'instant') {
      if (schema.minimum) validateInstant(schema.minimum, { kind: 'instant' }, []);
      if (schema.maximum) validateInstant(schema.maximum, { kind: 'instant' }, []);
      if (schema.minimum && schema.maximum && compareInstant(schema.minimum, schema.maximum) > 0)
        throw new TypeError('invalid instant range');
    }
    if (schema.kind === 'list') {
      if (schema.maxItems !== undefined) assertLimit(schema.maxItems, 'maxItems');
      visit(schema.item);
    } else if (schema.kind === 'tuple') {
      schema.items.forEach(visit);
    } else if (schema.kind === 'record') {
      const names = new Set<string>();
      for (const field of schema.fields) {
        if (!FIELD_NAME.test(field.name) || names.has(field.name))
          throw new TypeError('invalid or duplicate record field');
        names.add(field.name);
        visit(field.schema);
      }
    } else if (schema.kind === 'variant') {
      const tags = new Set<string>();
      for (const variant of schema.variants) {
        if (!VARIANT_TAG.test(variant.tag) || tags.has(variant.tag))
          throw new TypeError('invalid or duplicate variant tag');
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
    if (schema.kind === 'variant')
      return schema.variants.some((variant) => canInhabit(variant.schema, new Set(checking)));
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
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
    fail('schema_mismatch', path, 'expected enumerable data property');
  return descriptor.value;
}

function validateDataArray(value: unknown[], path: ValuePath, ceiling: number): void {
  if (value.length > ceiling) fail('limit_exceeded', path, 'array length exceeds limit');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
    fail('schema_mismatch', path, 'expected dense array data');
  for (let index = 0; index < value.length; index++)
    dataProperty(value as unknown as Record<string, unknown>, String(index), [...path, index]);
}

function compareInstant(left: InstantValue, right: InstantValue): number {
  return left.epochSeconds === right.epochSeconds
    ? left.nanoseconds - right.nanoseconds
    : left.epochSeconds < right.epochSeconds
      ? -1
      : 1;
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
  )
    fail('schema_mismatch', path, 'expected instant');
  const instant: InstantValue = { epochSeconds, nanoseconds };
  if (
    compareInstant(instant, TEMPORAL_MIN) < 0 ||
    compareInstant(instant, TEMPORAL_MAX) > 0 ||
    (schema.minimum && compareInstant(instant, schema.minimum) < 0) ||
    (schema.maximum && compareInstant(instant, schema.maximum) > 0)
  )
    fail('invalid_value', path, 'instant out of range');
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

interface EncodeTask {
  readonly schema: Schema;
  readonly value: unknown;
  readonly path: ValuePath;
  readonly depth: number;
}

/**
 * Encodes a value using the deterministic SafeScript CBOR profile and a required schema.
 *
 * @remarks Encoding validates shape and limits first; JavaScript object identity and insertion order never affect
 * the output bytes.
 */
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
          if (typeof integer !== 'bigint' || integer < -(1n << 63n) || integer > (1n << 63n) - 1n)
            fail('schema_mismatch', task.path, 'expected int64');
          if (
            (current.minimum !== undefined && integer < current.minimum) ||
            (current.maximum !== undefined && integer > current.maximum)
          )
            fail('invalid_value', task.path, 'int64 out of range');
          append(header(integer >= 0n ? 0 : 1, integer >= 0n ? integer : -1n - integer), task.path);
          break;
        }
        case 'float64': {
          const float = task.value;
          if (typeof float !== 'number' || !Number.isFinite(float))
            fail('schema_mismatch', task.path, 'expected finite float64');
          if (
            (current.minimum !== undefined && float < current.minimum) ||
            (current.maximum !== undefined && float > current.maximum)
          )
            fail('invalid_value', task.path, 'float64 out of range');
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
          if (current.maxBytes !== undefined && length > current.maxBytes)
            fail('limit_exceeded', task.path, 'string.maxBytes');
          const prefix = header(3, BigInt(length));
          if (output.length + prefix.length + length > limits.maxBytes) fail('limit_exceeded', task.path, 'maxBytes');
          const bytes = new TextEncoder().encode(task.value);
          append(prefix, task.path);
          append(bytes, task.path);
          break;
        }
        case 'bytes': {
          if (!Array.isArray(task.value)) fail('schema_mismatch', task.path, 'expected bytes');
          if (current.maxBytes !== undefined && task.value.length > current.maxBytes)
            fail('limit_exceeded', task.path, 'bytes.maxBytes');
          validateDataArray(task.value, task.path, limits.maxBytes - output.length);
          const byteValues: unknown[] = [];
          for (let index = 0; index < task.value.length; index++)
            byteValues.push(
              dataProperty(task.value as unknown as Record<string, unknown>, String(index), [...task.path, index]),
            );
          if (!byteValues.every((byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255))
            fail('schema_mismatch', task.path, 'expected bytes');
          append(header(2, BigInt(task.value.length)), task.path);
          append(byteValues as number[], task.path);
          break;
        }
        case 'instant':
          validateInstant(task.value, current, task.path);
          append(header(4, 2n), task.path);
          tasks.push({
            schema: { kind: 'int64', minimum: 0n, maximum: 999_999_999n },
            value: BigInt(
              dataProperty(task.value as unknown as Record<string, unknown>, 'nanoseconds', [
                ...task.path,
                'nanoseconds',
              ]) as number,
            ),
            path: [...task.path, 'nanoseconds'],
            depth: task.depth + 1,
          });
          tasks.push({
            schema: { kind: 'int64' },
            value: dataProperty(task.value as unknown as Record<string, unknown>, 'epochSeconds', [
              ...task.path,
              'epochSeconds',
            ]),
            path: [...task.path, 'epochSeconds'],
            depth: task.depth + 1,
          });
          break;
        case 'list': {
          if (!Array.isArray(task.value)) fail('schema_mismatch', task.path, 'expected list');
          if (current.maxItems !== undefined && task.value.length > current.maxItems)
            fail('limit_exceeded', task.path, 'list.maxItems');
          validateDataArray(task.value, task.path, limits.maxNodes - nodes);
          append(header(4, BigInt(task.value.length)), task.path);
          for (let index = task.value.length - 1; index >= 0; index--)
            tasks.push({
              schema: current.item,
              value: dataProperty(task.value as unknown as Record<string, unknown>, String(index), [
                ...task.path,
                index,
              ]),
              path: [...task.path, index],
              depth: task.depth + 1,
            });
          break;
        }
        case 'tuple':
          if (!Array.isArray(task.value) || task.value.length !== current.items.length)
            fail('schema_mismatch', task.path, 'wrong tuple length');
          validateDataArray(task.value, task.path, limits.maxNodes - nodes);
          append(header(4, BigInt(current.items.length)), task.path);
          for (let index = current.items.length - 1; index >= 0; index--)
            tasks.push({
              schema: current.items[index] as Schema,
              value: dataProperty(task.value as unknown as Record<string, unknown>, String(index), [
                ...task.path,
                index,
              ]),
              path: [...task.path, index],
              depth: task.depth + 1,
            });
          break;
        case 'record': {
          if (!validPlainRecord(task.value)) fail('schema_mismatch', task.path, 'expected record');
          const record = task.value;
          const names = current.fields.map((field) => field.name);
          if (Object.keys(record).length !== names.length || names.some((name) => !Object.hasOwn(record, name)))
            fail('schema_mismatch', task.path, 'record fields do not match schema');
          append(header(4, BigInt(names.length)), task.path);
          for (let index = current.fields.length - 1; index >= 0; index--) {
            const field = current.fields[index] as RecordField;
            tasks.push({
              schema: field.schema,
              value: dataProperty(record, field.name, [...task.path, field.name]),
              path: [...task.path, field.name],
              depth: task.depth + 1,
            });
          }
          break;
        }
        case 'variant': {
          if (
            !validPlainRecord(task.value) ||
            Object.keys(task.value).length !== 2 ||
            !Object.hasOwn(task.value, 'tag') ||
            !Object.hasOwn(task.value, 'value')
          )
            fail('schema_mismatch', task.path, 'expected variant');
          const value = task.value;
          const tag = dataProperty(value, 'tag', [...task.path, 'tag']);
          const payload = dataProperty(value, 'value', [...task.path, 'value']);
          if (typeof tag !== 'string') fail('schema_mismatch', [...task.path, 'tag'], 'expected variant tag');
          const variant = current.variants.find((candidate) => candidate.tag === tag);
          if (!variant) fail('schema_mismatch', [...task.path, 'tag'], 'unknown variant');
          append(header(4, 2n), task.path);
          tasks.push({ schema: variant.schema, value: payload, path: [...task.path, 'value'], depth: task.depth + 1 });
          tasks.push({
            schema: { kind: 'string' },
            value: variant.tag,
            path: [...task.path, 'tag'],
            depth: task.depth + 1,
          });
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
interface DecodeTask {
  readonly kind: 'value';
  readonly schema: Schema;
  readonly path: ValuePath;
  readonly depth: number;
  readonly assign: Assign;
}
interface VariantTask {
  readonly kind: 'variant';
  readonly schema: VariantSchema;
  readonly path: ValuePath;
  readonly depth: number;
  readonly target: Record<string, CanonicalValue>;
}
type ParseTask = DecodeTask | VariantTask;

class Decoder {
  offset = 0;
  nodes = 0;
  readonly text = new TextDecoder('utf-8', { fatal: true });

  constructor(
    readonly bytes: Uint8Array,
    readonly limits: ValueLimits,
  ) {
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
    if (length > BigInt(Number.MAX_SAFE_INTEGER) || length > BigInt(ceiling))
      fail('limit_exceeded', path, 'declared length exceeds limit', this.offset);
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

/**
 * Decodes deterministic SafeScript CBOR and rejects alternate, non-canonical, malformed, or out-of-schema forms.
 */
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
    const tasks: ParseTask[] = [
      {
        kind: 'value',
        schema,
        path: [],
        depth: 0,
        assign: (value) => {
          root = value;
        },
      },
    ];
    while (tasks.length > 0) {
      const task = tasks.pop() as ParseTask;
      if (task.kind === 'variant') {
        if (task.depth + 1 > limits.maxDepth) fail('limit_exceeded', [...task.path, 'tag'], 'maxDepth', decoder.offset);
        if (++decoder.nodes > limits.maxNodes)
          fail('limit_exceeded', [...task.path, 'tag'], 'maxNodes', decoder.offset);
        const tag = decoder.string([...task.path, 'tag']);
        const variant = task.schema.variants.find((candidate) => candidate.tag === tag);
        if (!variant) fail('schema_mismatch', [...task.path, 'tag'], 'unknown variant', decoder.offset);
        task.target.tag = tag;
        tasks.push({
          kind: 'value',
          schema: variant.schema,
          path: [...task.path, 'value'],
          depth: task.depth + 1,
          assign: (value) => {
            task.target.value = value;
          },
        });
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
          if (byte !== 0xf4 && byte !== 0xf5)
            fail('schema_mismatch', task.path, 'expected boolean', decoder.offset - 1);
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
          if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n)
            fail('invalid_value', task.path, 'int64 out of range', start);
          if (
            (current.minimum !== undefined && integer < current.minimum) ||
            (current.maximum !== undefined && integer > current.maximum)
          )
            fail('invalid_value', task.path, 'int64 out of range', start);
          task.assign(integer);
          break;
        }
        case 'float64': {
          const start = decoder.offset;
          if (decoder.byte(task.path) !== 0xfb)
            fail('noncanonical_cbor', task.path, 'float64 must use binary64', start);
          if (decoder.offset + 8 > bytes.length) fail('malformed_cbor', task.path, 'truncated float64', decoder.offset);
          const float = new DataView(bytes.buffer, bytes.byteOffset + decoder.offset, 8).getFloat64(0);
          decoder.offset += 8;
          if (!Number.isFinite(float) || Object.is(float, -0))
            fail('noncanonical_cbor', task.path, 'invalid canonical float64', start);
          if (
            (current.minimum !== undefined && float < current.minimum) ||
            (current.maximum !== undefined && float > current.maximum)
          )
            fail('invalid_value', task.path, 'float64 out of range', start);
          task.assign(float);
          break;
        }
        case 'string':
          task.assign(decoder.string(task.path, current.maxBytes));
          break;
        case 'bytes': {
          const length = decoder.length(
            2,
            task.path,
            Math.min(current.maxBytes ?? limits.maxBytes, bytes.length - decoder.offset),
          );
          const end = decoder.offset + length;
          const value = Object.freeze(Array.from(bytes.subarray(decoder.offset, end)));
          decoder.offset = end;
          task.assign(value);
          break;
        }
        case 'instant': {
          if (decoder.head(4, task.path) !== 2n)
            fail('schema_mismatch', task.path, 'instant must have two fields', decoder.offset);
          const value: Record<string, CanonicalValue> = {};
          tasks.push({
            kind: 'value',
            schema: { kind: 'int64', minimum: 0n, maximum: 999_999_999n },
            path: [...task.path, 'nanoseconds'],
            depth: task.depth + 1,
            assign: (nanoseconds) => {
              value.nanoseconds = Number(nanoseconds);
              validateInstant(value, current, task.path);
              task.assign(Object.freeze(value) as unknown as InstantValue);
            },
          });
          tasks.push({
            kind: 'value',
            schema: { kind: 'int64' },
            path: [...task.path, 'epochSeconds'],
            depth: task.depth + 1,
            assign: (seconds) => {
              value.epochSeconds = seconds;
            },
          });
          break;
        }
        case 'list': {
          const ceiling = Math.min(current.maxItems ?? limits.maxNodes, limits.maxNodes - decoder.nodes);
          const length = decoder.length(4, task.path, ceiling);
          const value: CanonicalValue[] = new Array(length);
          task.assign(value);
          for (let index = length - 1; index >= 0; index--)
            tasks.push({
              kind: 'value',
              schema: current.item,
              path: [...task.path, index],
              depth: task.depth + 1,
              assign: (item) => {
                value[index] = item;
              },
            });
          break;
        }
        case 'tuple': {
          if (decoder.head(4, task.path) !== BigInt(current.items.length))
            fail('schema_mismatch', task.path, 'wrong tuple length', decoder.offset);
          const value: CanonicalValue[] = new Array(current.items.length);
          task.assign(value);
          for (let index = current.items.length - 1; index >= 0; index--)
            tasks.push({
              kind: 'value',
              schema: current.items[index] as Schema,
              path: [...task.path, index],
              depth: task.depth + 1,
              assign: (item) => {
                value[index] = item;
              },
            });
          break;
        }
        case 'record': {
          if (decoder.head(4, task.path) !== BigInt(current.fields.length))
            fail('schema_mismatch', task.path, 'wrong record field count', decoder.offset);
          const value: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
          task.assign(value);
          for (let index = current.fields.length - 1; index >= 0; index--) {
            const field = current.fields[index] as RecordField;
            tasks.push({
              kind: 'value',
              schema: field.schema,
              path: [...task.path, field.name],
              depth: task.depth + 1,
              assign: (item) => {
                value[field.name] = item;
              },
            });
          }
          break;
        }
        case 'variant': {
          if (decoder.head(4, task.path) !== 2n)
            fail('schema_mismatch', task.path, 'variant must have two fields', decoder.offset);
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

/** Validates a value by encoding and decoding it into its immutable canonical representation. */
export function canonicalize(
  schema: Schema,
  value: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<CanonicalValue> {
  const encoded = encodeCanonical(schema, value, options);
  return encoded.ok ? decodeCanonical(schema, encoded.value, options) : encoded;
}

/** Compares schema-directed values by their canonical byte representation. */
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
  return Object.freeze({
    ok: true,
    value:
      leftBytes.value.length === rightBytes.value.length &&
      leftBytes.value.every((byte, index) => byte === rightBytes.value[index]),
  });
}

/** Computes a domain-separated digest over a schema-directed canonical value. */
export function digestCanonical(
  domain: HashDomain,
  schema: Schema,
  value: unknown,
  options: Readonly<{ registry?: SchemaRegistry; limits?: ValueLimits }> = {},
): ContractResult<Sha256Digest> {
  const encoded = encodeCanonical(schema, value, options);
  return encoded.ok ? Object.freeze({ ok: true, value: hash(domain, encoded.value) }) : encoded;
}

interface JsonTask {
  readonly kind: 'value';
  readonly input: unknown;
  readonly path: ValuePath;
  readonly depth: number;
  readonly assign: (value: JsonValue) => void;
}

interface JsonExitTask {
  readonly kind: 'exit';
  readonly input: object;
}

/** Converts ordinary parsed JSON into the bounded tagged {@link JsonValue} representation. */
export function canonicalJson(input: unknown, limits: ValueLimits = STANDARD_VALUE_LIMITS): ContractResult<JsonValue> {
  try {
    let root: JsonValue = { tag: 'null', value: null };
    let nodes = 0;
    const active = new Set<object>();
    const tasks: (JsonTask | JsonExitTask)[] = [
      {
        kind: 'value',
        input,
        path: [],
        depth: 0,
        assign: (value) => {
          root = value;
        },
      },
    ];
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
        for (let index = task.input.length - 1; index >= 0; index--)
          tasks.push({
            kind: 'value',
            input: dataProperty(task.input as unknown as Record<string, unknown>, String(index), [...task.path, index]),
            path: [...task.path, index],
            depth: task.depth + 1,
            assign: (value) => {
              values[index] = value;
            },
          });
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
          tasks.push({
            kind: 'value',
            input: dataProperty(task.input, key, [...task.path, key]),
            path: [...task.path, key],
            depth: task.depth + 1,
            assign: (value) => {
              entries[index] = [key, value];
            },
          });
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
      for (let index = 0; index < value.length; index++)
        pending.push(dataProperty(value as unknown as Record<string, unknown>, String(index), [index]));
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
      if (previous !== undefined && compareUtf8(previous, key) >= 0)
        fail('invalid_value', [], 'JSON object keys are not strictly sorted');
      previous = key;
      pending.push(dataProperty(entry as unknown as Record<string, unknown>, '1', [index, 1]));
    }
  }
}

/** Built-in type identity for the recursive tagged JSON representation. */
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
/** Schema registry containing only the built-in recursive {@link JsonValue} definition. */
export const JSON_VALUE_REGISTRY = defineSchemaRegistry([
  {
    id: JSON_VALUE_TYPE,
    schema: JSON_VALUE_SCHEMA,
    fingerprint: hash('type', new TextEncoder().encode('safescript.json-value.v1')),
  },
]);

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

/** Half-open source span in one submitted module. */
export interface SourceLocation {
  readonly module: ModuleId;
  readonly start: number;
  readonly end: number;
}

/** Closed compiler diagnostics. Codes describe source semantics, never private checking or lowering passes. */
export const COMPILER_DIAGNOSTIC_CODES = Object.freeze([
  'SS_AMBIENT_AUTHORITY',
  'SS_CLASS_REJECTED',
  'SS_COMPILER_LIMIT',
  'SS_CONTEXT_REQUIRED',
  'SS_CONTRACT_INVALID',
  'SS_DUPLICATE_BINDING',
  'SS_DYNAMIC_IMPORT',
  'SS_EXCEPTION_REJECTED',
  'SS_FLOATING_ACTION',
  'SS_GENERATED_CODE',
  'SS_GENERATOR_REJECTED',
  'SS_HANDLER_SHAPE',
  'SS_IMMUTABLE_ASSIGNMENT',
  'SS_IMPORT_FORM',
  'SS_IMPORT_NAME',
  'SS_INTERNAL_IR_INVALID',
  'SS_INVALID_ACTION',
  'SS_LOCALE_REJECTED',
  'SS_MISSING_RETURN',
  'SS_MODULE_SHAPE',
  'SS_MUTABLE_BINDING',
  'SS_NULL_REJECTED',
  'SS_NUMERIC_LITERAL',
  'SS_PROMISE_CONCURRENCY',
  'SS_RECORD_SHAPE',
  'SS_REGEX_REJECTED',
  'SS_RESULT_CONSTRUCTION',
  'SS_RETURN_TYPE',
  'SS_SOURCE_ENCODING',
  'SS_SWITCH_EXHAUSTIVE',
  'SS_SWITCH_TYPE',
  'SS_SYNTAX',
  'SS_TEMPLATE_TYPE',
  'SS_TYPE_MISMATCH',
  'SS_UNKNOWN_FIELD',
  'SS_UNKNOWN_IDENTIFIER',
  'SS_UNREACHABLE_CODE',
  'SS_UNSAFE_ASSERTION',
  'SS_UNSAFE_TYPE',
  'SS_UNSUPPORTED_BINDING',
  'SS_UNSUPPORTED_EXPRESSION',
  'SS_UNSUPPORTED_FUNCTION',
  'SS_UNSUPPORTED_OPERATOR',
  'SS_UNSUPPORTED_SYNTAX',
  'SS_VALUE_MUTATION',
] as const);
export type CompilerDiagnosticCode = (typeof COMPILER_DIAGNOSTIC_CODES)[number];

/** Stable repair classification for coding agents and editor integrations. */
export type DiagnosticCategory =
  'authority' | 'contract' | 'control-flow' | 'effects' | 'modules' | 'resources' | 'syntax' | 'types';

/** Structured, non-authoritative guidance for repairing one rejected source program. */
export interface DiagnosticRepair {
  readonly category: DiagnosticCategory;
  readonly action: string;
}

/** Returns bounded repair guidance without exposing private compiler representation or pass details. */
export function diagnosticRepair(code: CompilerDiagnosticCode): DiagnosticRepair {
  if (code === 'SS_AMBIENT_AUTHORITY')
    return { category: 'authority', action: 'Remove ambient access and use a registered operation on ctx.' };
  if (code === 'SS_COMPILER_LIMIT')
    return { category: 'resources', action: 'Reduce source, type, template, or module complexity within slot limits.' };
  if (code === 'SS_RECORD_SHAPE')
    return { category: 'types', action: 'Use exact fields and expand shorthand { value } to { value: value }.' };
  if (code === 'SS_CONTRACT_INVALID' || code === 'SS_CONTEXT_REQUIRED')
    return {
      category: 'contract',
      action: 'Use the exact generated slot context, declarations, and language version.',
    };
  if (
    code === 'SS_DYNAMIC_IMPORT' ||
    code === 'SS_IMPORT_FORM' ||
    code === 'SS_IMPORT_NAME' ||
    code === 'SS_MODULE_SHAPE'
  )
    return { category: 'modules', action: 'Use only supported static imports from host:api or safescript:prelude.' };
  if (
    code === 'SS_FLOATING_ACTION' ||
    code === 'SS_INVALID_ACTION' ||
    code === 'SS_PROMISE_CONCURRENCY' ||
    code === 'SS_RESULT_CONSTRUCTION'
  )
    return { category: 'effects', action: 'Call ctx directly, consume each action once, and handle its typed Result.' };
  if (
    code === 'SS_MISSING_RETURN' ||
    code === 'SS_SWITCH_EXHAUSTIVE' ||
    code === 'SS_SWITCH_TYPE' ||
    code === 'SS_UNREACHABLE_CODE'
  )
    return { category: 'control-flow', action: 'Make every reachable path return and handle every closed union tag.' };
  if (
    code === 'SS_CLASS_REJECTED' ||
    code === 'SS_EXCEPTION_REJECTED' ||
    code === 'SS_GENERATED_CODE' ||
    code === 'SS_GENERATOR_REJECTED' ||
    code === 'SS_LOCALE_REJECTED' ||
    code === 'SS_REGEX_REJECTED' ||
    code === 'SS_SYNTAX' ||
    code === 'SS_UNSUPPORTED_EXPRESSION' ||
    code === 'SS_UNSUPPORTED_FUNCTION' ||
    code === 'SS_UNSUPPORTED_OPERATOR' ||
    code === 'SS_UNSUPPORTED_SYNTAX'
  )
    return { category: 'syntax', action: 'Rewrite with constructs listed by the supplied language profile.' };
  return { category: 'types', action: 'Use explicit safe types, immutable values, and exact declared record shapes.' };
}

/** Stable compiler diagnostic safe for editors, agents, and bridge transports. */
export interface Diagnostic {
  readonly code: CompilerDiagnosticCode;
  readonly severity: 'error' | 'warning' | 'info';
  /** Human-facing, bounded, non-normative text. Consumers branch on `code` and structured fields instead. */
  readonly message: string;
  readonly repair: DiagnosticRepair;
  readonly location?: SourceLocation;
  readonly related?: readonly SourceLocation[];
}

/** Adapter or request-envelope failure outside source and execution semantics. */
export interface BridgeError {
  readonly code: BridgeErrorCode;
  readonly phase: 'check' | 'inspect' | 'execute' | 'cancel' | 'close' | 'action';
  readonly detail?: string;
}

/** Closed request, bridge-lifecycle, and artefact-preparation failures. */
export type BridgeErrorCode =
  | 'adapter_failure'
  | 'artifact_verification_failed'
  | 'bridge_closed'
  | 'capacity_exceeded'
  | 'invalid_request'
  | 'unsupported_version'
  | 'worker_close_timeout'
  | 'worker_identity_mismatch'
  | 'worker_lost'
  | 'worker_start_failed'
  | 'worker_start_timeout';

function exactDataRecord(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = [...keys].sort();
    const actual = Object.keys(descriptors).sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]) &&
      actual.every((key) => descriptors[key] && 'value' in descriptors[key])
    );
  } catch {
    return false;
  }
}

/** Closed infrastructure and host-adapter failures that terminate execution. */
export const HOST_FAILURE_CODES = Object.freeze([
  'cancelled',
  'gateway_fault',
  'handler_fault',
  'invalid_result',
  'timeout',
  'transport_lost',
  'unavailable',
] as const);
export type HostFailureCode = (typeof HOST_FAILURE_CODES)[number];
/** Bounded host failure safe to return without exposing exceptions or stack traces. */
export interface HostFailure {
  readonly code: HostFailureCode;
  readonly detail?: string;
}
/** Knowledge of whether a failed host operation changed external state. `unknown` is never safe to retry implicitly. */
export type EffectState = 'not_performed' | 'unknown';

/** Source provenance retained on an action site after lowering to IR. */
export interface SourceProvenance {
  readonly module: ModuleId;
  readonly start: number;
  readonly end: number;
}

/**
 * Canonical request for one registered host operation.
 *
 * @remarks Recording this request proves only that the operation was proposed. The SDK gateway validates the
 * envelope before dispatching a handler; host lifecycle policy remains a separate concern.
 */
export interface ActionRequest {
  readonly contractId: ContractId;
  readonly irDigest: IrDigest;
  readonly invocationId: InvocationId;
  readonly requestId: RequestId;
  readonly slotId: SlotId;
  readonly operationId: OperationId;
  readonly actionSiteId: ActionSiteId;
  readonly source: SourceProvenance;
  readonly input: CanonicalBytes;
}

/** Terminal typed resolution of one action request. */
export type ActionOutcome = Readonly<{
  requestId: RequestId;
  result:
    | Readonly<{ tag: 'completed'; value: CanonicalBytes }>
    | Readonly<{ tag: 'failed'; value: Readonly<{ effectState: EffectState; failure: HostFailure }> }>;
}>;

/** Fail-closed structural validator for a terminal action outcome. */
export function isActionOutcome(
  value: unknown,
  requestId?: RequestId,
  maxBytes = Number.MAX_SAFE_INTEGER,
): value is ActionOutcome {
  if (!exactDataRecord(value, ['requestId', 'result'])) return false;
  if (typeof value.requestId !== 'string') return false;
  try {
    ids.parseRequest(value.requestId);
  } catch {
    return false;
  }
  if (requestId !== undefined && value.requestId !== requestId) return false;
  if (!exactDataRecord(value.result, ['tag', 'value'])) return false;
  if (value.result.tag === 'completed')
    return (
      Array.isArray(value.result.value) &&
      value.result.value.length <= maxBytes &&
      value.result.value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    );
  if (value.result.tag !== 'failed' || !exactDataRecord(value.result.value, ['effectState', 'failure'])) return false;
  const effectState = value.result.value.effectState;
  const failure = value.result.value.failure;
  if (!exactDataRecord(failure, ['code']) && !exactDataRecord(failure, ['code', 'detail'])) return false;
  return Boolean(
    (effectState === 'not_performed' || effectState === 'unknown') &&
    typeof failure.code === 'string' &&
    (HOST_FAILURE_CODES as readonly string[]).includes(failure.code) &&
    (failure.detail === undefined ||
      (typeof failure.detail === 'string' && failure.detail.length <= MAX_FAILURE_DETAIL_LENGTH)),
  );
}

/** Ordered in-memory fact distinguishing request creation from terminal resolution. */
export type ActionRecord =
  | Readonly<{ phase: 'requested'; request: ActionRequest }>
  | Readonly<{ phase: 'resolved'; requestId: RequestId; outcome: ActionOutcome }>;

/** Structural requirement for one contract-owned definition. */
export interface DefinitionFingerprint {
  readonly id: ContractOwnedId;
  readonly fingerprint: Sha256Digest;
}
/** Language-neutral operation metadata used by the compiler, runtime, and SDK gateway. */
export interface OperationDefinition {
  readonly id: OperationId;
  readonly input: TypeId;
  readonly output: TypeId;
  readonly error: TypeId;
  readonly effectCost: number;
  readonly fingerprint: Sha256Digest;
}
/** Language-neutral extension-slot policy and resource ceilings. */
export interface SlotDefinition {
  readonly id: SlotId;
  readonly input: TypeId;
  readonly output: TypeId;
  readonly operations: readonly OperationId[];
  readonly compileLimits: CompileLimits;
  readonly executionLimits: ExecutionLimits;
  readonly fingerprint: Sha256Digest;
}
/**
 * Canonical machine-readable authority derived from one host contract.
 *
 * @remarks The registry contains schemas and static eligibility metadata, never live handlers, credentials, or a
 * cached runtime decision.
 */
export interface ContractRegistry {
  readonly id: ContractId;
  readonly digest: Sha256Digest;
  readonly schemas: SchemaRegistry;
  readonly operations: readonly OperationDefinition[];
  readonly slots: readonly SlotDefinition[];
  readonly definitions: readonly DefinitionFingerprint[];
}

/** Structural contract-compatibility failure for a referenced definition. */
export interface DefinitionCompatibilityFailure {
  readonly code: 'invalid_contract_digest' | 'invalid_definition_id' | 'missing_definition' | 'fingerprint_mismatch';
  readonly id?: ContractOwnedId;
}

/** Checks that every referenced definition still exists with the exact structural fingerprint. */
export function checkDefinitionCompatibility(
  registry: ContractRegistry,
  required: readonly DefinitionFingerprint[],
): readonly DefinitionCompatibilityFailure[] {
  const failures: DefinitionCompatibilityFailure[] = [];
  if (!SHA256.test(registry.digest)) failures.push({ code: 'invalid_contract_digest' });
  const current = new Map(registry.definitions.map((definition) => [definition.id, definition.fingerprint] as const));
  for (const definition of required) {
    const [prefix, name] = String(definition.id).split(':', 2);
    if (!['type', 'operation', 'slot'].includes(prefix ?? '') || !HOST_NAME.test(name ?? '')) {
      failures.push({ code: 'invalid_definition_id', id: definition.id });
    } else if (!current.has(definition.id)) {
      failures.push({ code: 'missing_definition', id: definition.id });
    } else if (!SHA256.test(definition.fingerprint) || current.get(definition.id) !== definition.fingerprint) {
      failures.push({ code: 'fingerprint_mismatch', id: definition.id });
    }
  }
  return Object.freeze(failures.map((failure) => Object.freeze(failure)));
}

/** Complete canonical UTF-8 source bytes for one explicitly named module. */
export interface SourceProgram {
  readonly module: ModuleId;
  readonly source: CanonicalBytes;
}

/** Hashes one named source module after validating its canonical bytes. */
export function programHash(program: SourceProgram): ContractResult<ProgramHash> {
  try {
    ids.module(program.module);
  } catch {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({ code: 'invalid_value', path: Object.freeze(['module']), detail: 'invalid module ID' }),
    });
  }
  if (
    !Array.isArray(program.source) ||
    !program.source.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    return Object.freeze({
      ok: false,
      failure: Object.freeze({
        code: 'invalid_value',
        path: Object.freeze(['source']),
        detail: 'invalid source bytes',
      }),
    });
  const schema: Schema = {
    kind: 'tuple',
    items: [{ kind: 'string' }, { kind: 'string' }],
  };
  const digest = digestCanonical('program', schema, [program.module, sourceHash(Uint8Array.from(program.source))]);
  return digest.ok ? Object.freeze({ ok: true, value: digest.value as unknown as ProgramHash }) : digest;
}
/** Deterministic compiler resources consumed by one check. */
export interface CompileUsage {
  readonly sourceBytes: number;
  readonly syntaxNodes: number;
}
/** Deterministic semantic resources consumed by one started execution. */
export interface ExecutionUsage {
  readonly fuel: number;
  readonly allocations: number;
  /** Total canonical bytes allocated during the invocation. */
  readonly allocatedBytes: number;
  readonly peakCollectionItems: number;
  readonly peakValueDepth: number;
  readonly peakValueNodes: number;
  readonly peakValueBytes: number;
  readonly peakCallDepth: number;
  readonly hostCalls: number;
  readonly traceBytes: number;
  readonly outputBytes: number;
}
/** Statically reachable operations; this summary does not grant runtime authority. */
export interface ProgramSummary {
  readonly operations: readonly OperationId[];
}
/** Compiler identity that produced an accepted artifact. */
export interface CompilerProvenance {
  readonly compiler: CompilerVersion;
}

/** Complete transport-neutral inputs required to check source without ambient discovery. */
export interface CheckRequest {
  readonly registry: ContractRegistry;
  readonly slotId: SlotId;
  readonly source: SourceProgram;
  readonly limits: CompileLimits;
  /** Whether accepted source should also be serialized as portable artifact bytes. */
  readonly includeArtifact?: boolean;
  /** Untrusted host-store candidate to verify on an in-memory cache miss. */
  readonly cachedArtifact?: CanonicalBytes;
}

/** Accepted source, rejected source diagnostics, or a bridge-envelope failure. */
export type CheckResult =
  | Readonly<{
      status: 'accepted';
      artifact?: CanonicalBytes;
      summary: ProgramSummary;
      provenance: CompilerProvenance;
      usage: CompileUsage;
      diagnostics: readonly Diagnostic[];
    }>
  | Readonly<{ status: 'rejected'; diagnostics: readonly Diagnostic[]; usage: CompileUsage }>
  | Readonly<{ status: 'bridge_error'; error: BridgeError }>;

/** Read-only derived views available from an accepted compilation. */
export type InspectView = 'semantic_graph';

/** Independent ceilings for disposable semantic graph export. */
export interface SemanticGraphLimits {
  readonly nodes: number;
  readonly edges: number;
  readonly bytes: number;
}

/** Conservative graph-export ceilings; callers may only lower them. */
export const STANDARD_SEMANTIC_GRAPH_LIMITS: SemanticGraphLimits = Object.freeze({
  nodes: 100_000,
  edges: 250_000,
  bytes: 4 * 1024 * 1024,
});

/** Closed source-semantic fact kinds. Consumers must reject kinds they do not understand. */
export type SemanticNodeKind = 'declaration' | 'expression' | 'control' | 'input' | 'output' | 'constant' | 'action';

/** Closed semantic sub-kinds emitted by graph schema 1.x. */
export type SemanticNodeSemanticKind =
  | 'program'
  | 'handler'
  | 'function'
  | 'variable'
  | 'destructure'
  | 'assign'
  | 'expression'
  | 'if'
  | 'for-of'
  | 'for-in'
  | 'loop'
  | 'break'
  | 'continue'
  | 'return'
  | 'switch'
  | 'slot-input'
  | 'control-parameter'
  | 'constant'
  | 'project-field'
  | 'compare'
  | 'binary'
  | 'construct-record'
  | 'construct-variant'
  | 'build-template'
  | 'jump'
  | 'branch'
  | 'action'
  | 'structured'
  | 'host-action'
  | 'return-value'
  | 'literal'
  | 'name'
  | 'member'
  | 'index'
  | 'array'
  | 'object'
  | 'template'
  | 'unary'
  | 'conditional'
  | 'call'
  | 'result';

/** Closed relationships between public semantic facts. */
export type SemanticEdgeKind = 'contains' | 'control' | 'data' | 'input' | 'output';

/** One typed, source-derived semantic fact. Source spans are navigation metadata, not identity. */
export interface SemanticGraphNode {
  readonly id: SemanticNodeId;
  readonly kind: SemanticNodeKind;
  readonly semanticKind: SemanticNodeSemanticKind;
  readonly source?: SourceLocation;
  readonly label?: string;
  readonly type?: Schema;
  readonly symbolId?: SymbolId;
  readonly actionSiteId?: ActionSiteId;
  readonly operationId?: OperationId;
  readonly constant?: null | boolean | number | string;
  readonly operator?: string;
  readonly effectCost?: number;
}

/** One deterministic relationship between semantic facts. */
export interface SemanticGraphEdge {
  readonly kind: SemanticEdgeKind;
  readonly from: SemanticNodeId;
  readonly to: SemanticNodeId;
  readonly label?: string;
}

/** Static resource facts derived from the accepted program, never runtime usage. */
export interface SemanticGraphResources {
  readonly declarations: number;
  readonly expressions: number;
  readonly controlPoints: number;
  readonly actionSites: number;
  readonly potentialEffectCost: number;
  readonly declarationNodes: readonly SemanticNodeId[];
  readonly expressionNodes: readonly SemanticNodeId[];
  readonly controlNodes: readonly SemanticNodeId[];
  readonly actionNodes: readonly SemanticNodeId[];
}

/** Complete, disposable source-semantic projection for one accepted program. */
export interface SemanticGraph {
  readonly sourceHash: SourceHash;
  readonly programHash: ProgramHash;
  readonly compiler: CompilerVersion;
  readonly contract: Readonly<{ id: ContractId; digest: Sha256Digest }>;
  readonly slotId: SlotId;
  readonly moduleId: ModuleId;
  readonly root: SemanticNodeId;
  readonly nodes: readonly SemanticGraphNode[];
  readonly edges: readonly SemanticGraphEdge[];
  readonly operations: readonly OperationId[];
  readonly resources: SemanticGraphResources;
}

/** A requested view may fail independently after source checking has succeeded. */
export interface SemanticGraphError {
  readonly code: 'graph_limit_exceeded';
  readonly limit: keyof SemanticGraphLimits;
  readonly maximum: number;
  readonly actual: number;
}

/** Check request plus the bounded derived views requested by the caller. */
export interface InspectRequest extends CheckRequest {
  readonly views: readonly InspectView[];
  readonly graphLimits?: SemanticGraphLimits;
}
/** Inspection result; rejected source never returns a partial trusted view. */
export type InspectResult =
  | Readonly<{
      status: 'accepted';
      check: Extract<CheckResult, { status: 'accepted' }>;
      views: Readonly<Partial<Record<InspectView, CanonicalBytes>>>;
      viewErrors: Readonly<Partial<Record<InspectView, SemanticGraphError>>>;
    }>
  | Extract<CheckResult, { status: 'rejected' | 'bridge_error' }>;

/** Source to compile and execute in one call, or previously checked artifact bytes to reverify. */
export type ExecutableProgram =
  Readonly<{ kind: 'source'; source: CheckRequest }> | Readonly<{ kind: 'artifact'; bytes: CanonicalBytes }>;
/** Complete transport-neutral execution inputs; host invocation context remains in the SDK. */
export interface ExecuteRequest {
  readonly registry: ContractRegistry;
  readonly slotId: SlotId;
  readonly invocationId: InvocationId;
  readonly program: ExecutableProgram;
  readonly input: CanonicalBytes;
  readonly limits: ExecutionLimits;
  readonly fixedInstant?: InstantValue;
  readonly randomSeed?: CanonicalBytes;
  /** Whether to collect bounded semantic trace records for this invocation. */
  readonly trace: boolean;
}

/** Bounded canonical trace records and an explicit truncation marker. */
export interface TraceResult {
  readonly records: readonly CanonicalBytes[];
  readonly truncated: boolean;
}
/** Trusted preparation facts returned for every started source or artifact execution. */
export type ExecutionPreparation =
  | Readonly<{
      kind: 'source';
      artifact?: CanonicalBytes;
      summary: ProgramSummary;
      provenance: CompilerProvenance;
      usage: CompileUsage;
      diagnostics: readonly Diagnostic[];
    }>
  | Readonly<{ kind: 'artifact'; irDigest: IrDigest }>;
/** Ordered action, trace, provenance, and resource facts returned by every started execution. */
export interface ExecutionFacts {
  readonly preparation: ExecutionPreparation;
  readonly actions: readonly ActionRecord[];
  readonly trace: TraceResult;
  readonly usage: ExecutionUsage;
}
/** Structured runtime failure safe to return without leaking an implementation exception. */
export const EXECUTION_ERROR_CODES = Object.freeze([
  'action_outcome_invalid',
  'cancelled',
  'fixed_instant_required',
  'gateway_fault',
  'handler_fault',
  'integer_overflow',
  'interpreter_fault',
  'invalid_arithmetic',
  'invalid_input',
  'invalid_ir',
  'invalid_output',
  'invalid_result',
  'non_finite_number',
  'random_seed_required',
  'resource_exhausted',
  'timeout',
  'transport_lost',
  'unavailable',
  'value_limit',
] as const);
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];
export interface ExecutionError {
  readonly code: ExecutionErrorCode;
  readonly detail?: string;
  readonly source?: SourceProvenance;
}

/** Public failure domains remain distinct even though their codes share one compatibility catalog. */
export type FailureDomain =
  'diagnostic' | 'validation' | 'artifact' | 'inspection' | 'execution' | 'action' | 'cancellation' | 'bridge';
/** Component responsible for assigning and preserving one stable failure meaning. */
export type FailureOwner =
  | 'compiler'
  | 'contract_codec'
  | 'contract_registry'
  | 'artifact_verifier'
  | 'semantic_graph'
  | 'interpreter'
  | 'resource_meter'
  | 'action_gateway'
  | 'cancellation'
  | 'runtime_bridge';
/** Closed structured fields which a catalogued failure may expose. */
export type FailureField =
  | 'actual'
  | 'byteOffset'
  | 'detail'
  | 'effectState'
  | 'id'
  | 'limit'
  | 'location'
  | 'maximum'
  | 'path'
  | 'phase'
  | 'related'
  | 'source';

export type SafeScriptFailureCode =
  | CompilerDiagnosticCode
  | ContractFailureCode
  | DefinitionCompatibilityFailure['code']
  | SemanticGraphError['code']
  | ExecutionErrorCode
  | BridgeErrorCode;

/** One stable, serialisable catalog entry. `meaning` is normative; rendered messages are not. */
export interface FailureCatalogEntry {
  readonly code: SafeScriptFailureCode;
  readonly domain: FailureDomain;
  readonly owner: FailureOwner;
  readonly meaning: string;
  readonly fields: readonly FailureField[];
  readonly sourceProvenance: 'required' | 'optional' | 'not_applicable';
}

const COMPILER_DIAGNOSTIC_MEANINGS = Object.freeze([
  'ambient authority access',
  'class syntax',
  'compiler resource limit exhaustion',
  'missing contextual type',
  'invalid host contract',
  'duplicate lexical binding',
  'dynamic import',
  'exception control flow',
  'unconsumed asynchronous action',
  'generated code execution',
  'generator syntax',
  'invalid exported handler shape',
  'assignment to immutable binding',
  'unsupported static import form',
  'unknown imported name',
  'compiler produced unverifiable IR',
  'invalid host action use',
  'locale-dependent operation',
  'missing return',
  'invalid module-level program shape',
  'unsupported mutable binding',
  'null or undefined use',
  'invalid numeric literal',
  'nondeterministic promise competition',
  'invalid record construction',
  'regular expression use',
  'invalid Result construction',
  'invalid return type',
  'slot and source language mismatch',
  'invalid source encoding',
  'non-exhaustive switch',
  'invalid switch discriminant',
  'TypeScript parse failure',
  'unsupported template interpolation',
  'SafeScript type mismatch',
  'unknown record field',
  'unknown identifier',
  'unreachable source',
  'unsafe type assertion',
  'unsafe TypeScript type',
  'unsupported binding form',
  'unsupported expression form',
  'unsupported function form',
  'unsupported operator',
  'unsupported statement or declaration syntax',
  'mutation of immutable canonical value',
] as const);

function catalogEntry(
  code: SafeScriptFailureCode,
  domain: FailureDomain,
  owner: FailureOwner,
  meaning: string,
  fields: readonly FailureField[],
  sourceProvenance: FailureCatalogEntry['sourceProvenance'],
): FailureCatalogEntry {
  return Object.freeze({ code, domain, owner, meaning, fields: Object.freeze([...fields]), sourceProvenance });
}

const compilerCatalog = COMPILER_DIAGNOSTIC_CODES.map((code, index) =>
  catalogEntry(
    code,
    'diagnostic',
    'compiler',
    COMPILER_DIAGNOSTIC_MEANINGS[index] as string,
    ['location', 'related'],
    'required',
  ),
);

/**
 * Complete SafeScript-owned failure catalog, sorted by stable code.
 *
 * @remarks Policy and domain `Result` error codes remain contract-owned and are intentionally absent. Entries never
 * name compiler passes, private IR nodes, exception types, transports, or adapter implementation details.
 */
export const DIAGNOSTIC_CATALOG: readonly FailureCatalogEntry[] = Object.freeze(
  [
    ...compilerCatalog,
    ...(
      [
        'invalid_schema',
        'invalid_value',
        'limit_exceeded',
        'malformed_cbor',
        'noncanonical_cbor',
        'schema_mismatch',
        'trailing_bytes',
        'unknown_type',
      ] as const
    ).map((code) =>
      catalogEntry(
        code,
        'validation',
        'contract_codec',
        code.replaceAll('_', ' '),
        ['path', 'byteOffset', 'detail'],
        'not_applicable',
      ),
    ),
    catalogEntry(
      'invalid_contract_digest',
      'artifact',
      'contract_registry',
      'invalid contract registry digest',
      [],
      'not_applicable',
    ),
    catalogEntry(
      'invalid_definition_id',
      'artifact',
      'contract_registry',
      'invalid contract definition identifier',
      ['id'],
      'not_applicable',
    ),
    catalogEntry(
      'missing_definition',
      'artifact',
      'contract_registry',
      'required contract definition missing',
      ['id'],
      'not_applicable',
    ),
    catalogEntry(
      'fingerprint_mismatch',
      'artifact',
      'contract_registry',
      'contract definition fingerprint mismatch',
      ['id'],
      'not_applicable',
    ),
    catalogEntry(
      'artifact_verification_failed',
      'artifact',
      'artifact_verifier',
      'checked artifact verification failed',
      ['phase', 'detail'],
      'not_applicable',
    ),
    catalogEntry(
      'graph_limit_exceeded',
      'inspection',
      'semantic_graph',
      'semantic graph export limit exceeded',
      ['limit', 'maximum', 'actual'],
      'not_applicable',
    ),
    catalogEntry(
      'action_outcome_invalid',
      'action',
      'action_gateway',
      'host action outcome is malformed or mismatched',
      ['detail', 'source'],
      'optional',
    ),
    catalogEntry(
      'gateway_fault',
      'action',
      'action_gateway',
      'action gateway failed closed',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'handler_fault',
      'action',
      'action_gateway',
      'host action handler failed',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'invalid_result',
      'action',
      'action_gateway',
      'host action result failed validation',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'timeout',
      'action',
      'action_gateway',
      'host action deadline expired',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'transport_lost',
      'action',
      'action_gateway',
      'host action transport was lost',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'unavailable',
      'action',
      'action_gateway',
      'host action dependency is unavailable',
      ['detail', 'effectState', 'source'],
      'optional',
    ),
    catalogEntry(
      'cancelled',
      'cancellation',
      'cancellation',
      'invocation cancellation reached execution',
      ['source'],
      'optional',
    ),
    catalogEntry(
      'resource_exhausted',
      'execution',
      'resource_meter',
      'semantic execution resource limit exhausted',
      ['detail', 'source'],
      'optional',
    ),
    catalogEntry(
      'value_limit',
      'execution',
      'resource_meter',
      'canonical value limit exhausted',
      ['detail', 'source'],
      'optional',
    ),
    ...(
      [
        'fixed_instant_required',
        'integer_overflow',
        'interpreter_fault',
        'invalid_arithmetic',
        'invalid_input',
        'invalid_ir',
        'invalid_output',
        'non_finite_number',
        'random_seed_required',
      ] as const
    ).map((code) =>
      catalogEntry(code, 'execution', 'interpreter', code.replaceAll('_', ' '), ['detail', 'source'], 'optional'),
    ),
    catalogEntry(
      'adapter_failure',
      'bridge',
      'runtime_bridge',
      'runtime bridge adapter failed',
      ['phase', 'detail'],
      'not_applicable',
    ),
    catalogEntry(
      'bridge_closed',
      'bridge',
      'runtime_bridge',
      'runtime bridge is closed',
      ['phase', 'detail'],
      'not_applicable',
    ),
    catalogEntry(
      'capacity_exceeded',
      'bridge',
      'runtime_bridge',
      'negotiated worker transport capacity is exhausted',
      ['phase'],
      'not_applicable',
    ),
    catalogEntry(
      'invalid_request',
      'bridge',
      'runtime_bridge',
      'runtime bridge request is invalid',
      ['phase', 'detail'],
      'not_applicable',
    ),
    catalogEntry(
      'unsupported_version',
      'bridge',
      'runtime_bridge',
      'runtime bridge version is unsupported',
      ['phase', 'detail'],
      'not_applicable',
    ),
    catalogEntry(
      'worker_close_timeout',
      'bridge',
      'runtime_bridge',
      'worker graceful close exceeded its deadline',
      ['phase'],
      'not_applicable',
    ),
    catalogEntry(
      'worker_identity_mismatch',
      'bridge',
      'runtime_bridge',
      'worker package or build identity does not match launch policy',
      ['phase'],
      'not_applicable',
    ),
    catalogEntry(
      'worker_lost',
      'bridge',
      'runtime_bridge',
      'established worker connection ended unexpectedly',
      ['phase'],
      'not_applicable',
    ),
    catalogEntry(
      'worker_start_failed',
      'bridge',
      'runtime_bridge',
      'worker process or handshake failed before readiness',
      ['phase'],
      'not_applicable',
    ),
    catalogEntry(
      'worker_start_timeout',
      'bridge',
      'runtime_bridge',
      'worker startup or handshake exceeded its deadline',
      ['phase'],
      'not_applicable',
    ),
  ].sort((left, right) => left.code.localeCompare(right.code)),
);
/** Closed execution lifecycle result. Only `completed` contains a program output. */
export type ExecutionResult =
  | Readonly<{
      status: 'not_started';
      diagnostics?: readonly Diagnostic[];
      error?: BridgeError | ExecutionError;
      usage?: CompileUsage;
    }>
  | Readonly<{ status: 'completed'; output: CanonicalBytes; facts: ExecutionFacts }>
  | Readonly<{ status: 'failed'; error: ExecutionError; facts: ExecutionFacts }>
  | Readonly<{ status: 'cancelled'; error: ExecutionError; facts: ExecutionFacts }>
  | Readonly<{ status: 'bridge_error'; error: BridgeError }>;

/** Idempotent request to signal one active invocation. */
export interface CancelRequest {
  readonly invocationId: InvocationId;
}
/** Whether cancellation reached an active invocation or no live invocation matched. */
export interface CancelResult {
  readonly status: 'accepted' | 'not_active' | 'bridge_error';
  readonly error?: BridgeError;
}
/** Terminal result of idempotently closing a runtime bridge. */
export interface CloseResult {
  readonly status: 'closed' | 'bridge_error';
  readonly error?: BridgeError;
}

/** Live SDK adapter invoked only when execution reaches a validated action instruction. */
export interface RuntimeBridgeHost {
  handleAction(request: ActionRequest): Promise<ActionOutcome>;
}

/**
 * Small transport-neutral seam shared by direct and future process adapters.
 *
 * @remarks Methods resolve closed result unions for defined operational failures. Implementations must not leak raw
 * exceptions, compiler objects, interpreter frames, host context, or credentials across this interface.
 */
export interface RuntimeBridge {
  check(request: CheckRequest): Promise<CheckResult>;
  inspect(request: InspectRequest): Promise<InspectResult>;
  execute(request: ExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult>;
  cancel(request: CancelRequest): Promise<CancelResult>;
  close(): Promise<CloseResult>;
}

/** Creates one independently closable runtime bridge adapter. */
export type RuntimeBridgeFactory = () => RuntimeBridge;

export * from './worker-protocol.js';
export * from './worker-framing.js';
export * from './worker-handshake.js';
