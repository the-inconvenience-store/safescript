/**
 * Host contract authoring types and canonical contract derivation.
 * @packageDocumentation
 */
import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  supportsPolicyError,
  type CanonicalBytes,
  type CapabilityDefinition,
  type CapabilityId,
  type CompileLimits,
  type ContractId,
  type ContractRegistry,
  type EffectDefinition,
  type EffectId,
  type ExecutionLimits,
  type OperationDefinition,
  type OperationId,
  type Schema,
  type SchemaRegistry,
  type SemVer,
  type Sha256Digest,
  type SlotDefinition,
  type SlotId,
  type TypeDefinition,
  type TypeId,
  type Version,
} from '@safescript/contracts';

import { generateDeclarations } from './declarations.js';
import { completeLimits, encodeUtf8, freeze, stable } from './shared.js';

/** Host-startup configuration error raised while deriving a contract. */
export class ContractDefinitionError extends TypeError {
  override readonly name = 'ContractDefinitionError';
}

/** Couples a stable schema identity and runtime schema with its host-side TypeScript type. */
export interface ContractType<T> {
  readonly id: TypeId;
  readonly schema: Schema;
  readonly _type?: T;
}

/**
 * Declarative host-operation contract.
 *
 * @remarks `resourceScope` must be synchronous and pure. It extracts stable strings used for current authorisation;
 * it must not perform I/O or make a policy decision.
 */
export interface Operation<I, O, E> {
  readonly id: OperationId;
  readonly input: ContractType<I>;
  readonly output: ContractType<O>;
  readonly error: ContractType<E>;
  readonly effect: EffectId;
  readonly capability: CapabilityId;
  readonly effectCost: number;
  readonly idempotency: 'none' | 'required';
  readonly resourceScope: (input: I) => Readonly<Record<string, string>>;
}

/** Host-defined execution point with fixed input/output types, permissions, language, and ceiling limits. */
export interface Slot<I, O> {
  readonly id: SlotId;
  readonly input: ContractType<I>;
  readonly output: ContractType<O>;
  readonly languageVersion: Version;
  readonly effects: readonly EffectId[];
  readonly capabilities: readonly CapabilityId[];
  readonly compileLimits?: Partial<CompileLimits>;
  readonly executionLimits?: Partial<ExecutionLimits>;
}

/** Internal generic constraint for a named operation table. */
export type Operations = Readonly<
  Record<
    string,
    Omit<Operation<unknown, unknown, unknown>, 'resourceScope'> &
      Readonly<{ resourceScope: (input: never) => Readonly<Record<string, string>> }>
  >
>;
/** Internal generic constraint for a named extension-slot table. */
export type Slots = Readonly<Record<string, Slot<unknown, unknown>>>;

/** Single host-owned authority from which declarations, codecs, fingerprints, and registry records are derived. */
export interface ContractDefinition<O extends Operations, S extends Slots> {
  readonly id: ContractId;
  readonly version: SemVer;
  readonly types?: readonly ContractType<unknown>[];
  readonly operations: O;
  readonly slots: S;
}

/** Schema-directed canonical codec generated for one contract type. */
export interface Codec<T> {
  encode(value: T): CanonicalBytes;
  decode(bytes: Uint8Array | CanonicalBytes): T;
}

/** Validated, deeply immutable result of {@link defineContract}. */
export interface Contract<O extends Operations, S extends Slots> {
  readonly id: ContractId;
  readonly version: SemVer;
  readonly registry: ContractRegistry;
  readonly fingerprint: Sha256Digest;
  readonly declarations: string;
  readonly codecs: Readonly<Record<string, Codec<unknown>>>;
  readonly operations: O;
  readonly slots: S;
}

function fingerprint(domain: 'type' | 'contract', value: unknown): Sha256Digest {
  return hash(domain, encodeUtf8(stable(value)));
}

function validateVersion(version: SemVer): void {
  if (
    !Number.isSafeInteger(version.major) ||
    version.major < 0 ||
    !Number.isSafeInteger(version.minor) ||
    version.minor < 0 ||
    !Number.isSafeInteger(version.patch) ||
    version.patch < 0 ||
    (version.prerelease !== undefined && !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(version.prerelease))
  )
    throw new TypeError('invalid contract version');
}

function referencedTypes<O extends Operations, S extends Slots>(
  definition: ContractDefinition<O, S>,
): ReadonlyMap<TypeId, ContractType<unknown>> {
  const referenced = [
    ...(definition.types ?? []),
    ...Object.values(definition.operations).flatMap((operation) => [
      operation.input,
      operation.output,
      operation.error,
    ]),
    ...Object.values(definition.slots).flatMap((slot) => [slot.input, slot.output]),
  ];
  const unique = new Map<TypeId, ContractType<unknown>>();
  for (const type of referenced) {
    ids.type(type.id);
    const existing = unique.get(type.id);
    if (existing && stable(existing.schema) !== stable(type.schema))
      throw new TypeError(`conflicting schema ${type.id}`);
    unique.set(type.id, type);
  }
  return unique;
}

function defineTypes(types: ReadonlyMap<TypeId, ContractType<unknown>>): readonly TypeDefinition[] {
  return [...types.values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((type) => ({ id: type.id, schema: type.schema, fingerprint: fingerprint('type', type.schema) }));
}

interface DerivedOperations {
  readonly operations: readonly OperationDefinition[];
  readonly effects: ReadonlyMap<EffectId, EffectDefinition>;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>;
}

function defineOperations<O extends Operations>(source: O, schemas: SchemaRegistry): DerivedOperations {
  const effects = new Map<EffectId, EffectDefinition>();
  const capabilities = new Map<CapabilityId, CapabilityDefinition>();
  const operations = Object.values(source)
    .map((operation): OperationDefinition => {
      ids.operation(operation.id);
      ids.effect(operation.effect);
      ids.capability(operation.capability);
      if (!Number.isSafeInteger(operation.effectCost) || operation.effectCost < 0)
        throw new TypeError(`invalid effect cost for ${operation.id}`);
      if (operation.idempotency !== 'none' && operation.idempotency !== 'required')
        throw new TypeError(`invalid idempotency for ${operation.id}`);
      if (typeof operation.resourceScope !== 'function')
        throw new TypeError(`missing resource scope for ${operation.id}`);
      if (!supportsPolicyError(operation.error.schema, schemas))
        throw new TypeError(`operation error must include policy for ${operation.id}`);
      effects.set(operation.effect, { id: operation.effect, fingerprint: fingerprint('contract', operation.effect) });
      capabilities.set(operation.capability, {
        id: operation.capability,
        fingerprint: fingerprint('contract', operation.capability),
      });
      const record = {
        id: operation.id,
        input: operation.input.id,
        output: operation.output.id,
        error: operation.error.id,
        effect: operation.effect,
        capability: operation.capability,
        effectCost: operation.effectCost,
        idempotency: operation.idempotency,
      };
      return { ...record, fingerprint: fingerprint('contract', record) };
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
    throw new TypeError('duplicate operation id');
  return { operations, effects, capabilities };
}

function validateSlotPermissions(
  slot: Slot<unknown, unknown>,
  effects: ReadonlyMap<EffectId, EffectDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
): void {
  for (const effect of slot.effects) {
    ids.effect(effect);
    if (!effects.has(effect)) throw new TypeError(`unknown effect ${effect}`);
  }
  for (const capability of slot.capabilities) {
    ids.capability(capability);
    if (!capabilities.has(capability)) throw new TypeError(`unknown capability ${capability}`);
  }
  if (
    new Set(slot.effects).size !== slot.effects.length ||
    new Set(slot.capabilities).size !== slot.capabilities.length
  )
    throw new TypeError(`duplicate slot permission ${slot.id}`);
}

function defineSlots<S extends Slots>(
  source: S,
  effects: ReadonlyMap<EffectId, EffectDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
): readonly SlotDefinition[] {
  const slots = Object.values(source)
    .map((slot): SlotDefinition => {
      ids.slot(slot.id);
      if (
        !Number.isSafeInteger(slot.languageVersion.major) ||
        slot.languageVersion.major < 0 ||
        !Number.isSafeInteger(slot.languageVersion.minor) ||
        slot.languageVersion.minor < 0
      )
        throw new TypeError(`invalid language version for ${slot.id}`);
      validateSlotPermissions(slot, effects, capabilities);
      const record = {
        id: slot.id,
        input: slot.input.id,
        output: slot.output.id,
        languageVersion: slot.languageVersion,
        effects: Object.freeze([...slot.effects]),
        capabilities: Object.freeze([...slot.capabilities]),
        compileLimits: completeLimits(STANDARD_COMPILE_LIMITS, slot.compileLimits),
        executionLimits: completeLimits(STANDARD_EXECUTION_LIMITS, slot.executionLimits),
      };
      return { ...record, fingerprint: fingerprint('contract', record) };
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length) throw new TypeError('duplicate slot id');
  return slots;
}

function sortedDefinitions<T extends { readonly id: string }>(values: Iterable<T>): readonly T[] {
  return [...values].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function defineCodecs(
  types: ReadonlyMap<TypeId, ContractType<unknown>>,
  schemas: SchemaRegistry,
): Readonly<Record<string, Codec<unknown>>> {
  return Object.fromEntries(
    [...types.values()].map((type) => [
      type.id,
      freeze({
        encode(value: unknown): CanonicalBytes {
          const result = encodeCanonical({ kind: 'ref', type: type.id }, value, { registry: schemas });
          if (!result.ok) throw new TypeError(`${result.failure.code} at ${result.failure.path.join('.')}`);
          return Object.freeze([...result.value]);
        },
        decode(bytes: Uint8Array | CanonicalBytes): unknown {
          const result = decodeCanonical({ kind: 'ref', type: type.id }, Uint8Array.from(bytes), { registry: schemas });
          if (!result.ok) throw new TypeError(`${result.failure.code} at ${result.failure.path.join('.')}`);
          return result.value;
        },
      }),
    ]),
  );
}

/**
 * Validates one host definition and derives every compiler, runtime, editor, and codec artifact from it.
 *
 * @remarks JavaScript handlers and resource-scope functions remain host-local and are deliberately omitted from the
 * serialisable registry.
 * @throws {@link ContractDefinitionError} if identities, schemas, permissions, versions, policy errors, limits, or
 * generated declaration names are inconsistent.
 */
export function defineContract<const O extends Operations, const S extends Slots>(
  definition: ContractDefinition<O, S>,
): Contract<O, S> {
  try {
    ids.contract(definition.id);
    validateVersion(definition.version);
    const uniqueTypes = referencedTypes(definition);
    const typeDefinitions = defineTypes(uniqueTypes);
    const schemas = defineSchemaRegistry(typeDefinitions);
    const derived = defineOperations(definition.operations, schemas);
    const operations = derived.operations;
    const slots = defineSlots(definition.slots, derived.effects, derived.capabilities);
    const sortedEffects = sortedDefinitions(derived.effects.values());
    const sortedCapabilities = sortedDefinitions(derived.capabilities.values());
    const definitions = [...typeDefinitions, ...sortedEffects, ...sortedCapabilities, ...operations, ...slots].map(
      ({ id, fingerprint: value }) => ({ id, fingerprint: value }),
    );
    const digest = fingerprint('contract', { id: definition.id, version: definition.version, definitions });
    const registry: ContractRegistry = freeze({
      id: definition.id,
      version: definition.version,
      digest,
      schemas,
      effects: sortedEffects,
      capabilities: sortedCapabilities,
      operations,
      slots,
      definitions,
    });
    const codecs = defineCodecs(uniqueTypes, schemas);
    const declarations = generateDeclarations(typeDefinitions, operations);
    return freeze({
      id: definition.id,
      version: definition.version,
      registry,
      fingerprint: digest,
      declarations,
      codecs,
      operations: definition.operations,
      slots: definition.slots,
    });
  } catch (error) {
    if (error instanceof ContractDefinitionError) throw error;
    throw new ContractDefinitionError(error instanceof Error ? error.message : 'invalid contract definition');
  }
}
