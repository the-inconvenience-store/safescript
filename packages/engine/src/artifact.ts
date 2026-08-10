/**
 * Creation and fail-closed verification of disposable checked execution artifacts.
 * @packageDocumentation
 */
import {
  checkDefinitionCompatibility,
  decodeCanonical,
  encodeCanonical,
  hash,
  programHash,
  type CanonicalBytes,
  type CheckRequest,
  type ContractRegistry,
  type IrDigest,
  type Schema,
  type SlotDefinition,
} from '@safescript/contracts';

import { verifyProgram, type StructuredProgram, type VerifiedStructuredProgram } from './structured-ir.js';

const encoder = new TextEncoder();
const ARTIFACT_SCHEMA: Schema = Object.freeze({ kind: 'string' });

interface ArtifactRecord {
  readonly magic: 'SafeScript checked artifact';
  readonly format: 2;
  readonly compiler: string;
  readonly contractId: string;
  readonly contractDigest: string;
  readonly definitions: readonly (readonly [string, string])[];
  readonly slotId: string;
  readonly sourceHash: string;
  readonly irDigest: string;
  readonly handler: string;
  readonly program: StructuredProgram;
}

/**
 * Private verified executable compilation retained by the direct bridge.
 * @internal
 */
export interface VerifiedCompilation {
  readonly digest: IrDigest;
  readonly program: VerifiedStructuredProgram;
  readonly handler: string;
}

function frozenBytes(bytes: Uint8Array | readonly number[]): CanonicalBytes {
  return Object.freeze(Array.from(bytes));
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return `{"$safescriptInt64":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('unsupported artifact value');
  return encoded;
}

function parse(text: string): unknown {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (
        entries.length === 1 &&
        entries[0]?.[0] === '$safescriptInt64' &&
        typeof entries[0][1] === 'string' &&
        /^-?(?:0|[1-9][0-9]*)$/.test(entries[0][1])
      )
        return BigInt(entries[0][1]);
    }
    return item;
  });
}

function isRecord(value: unknown): value is ArtifactRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ArtifactRecord>;
  return (
    record.magic === 'SafeScript checked artifact' &&
    record.format === 2 &&
    typeof record.compiler === 'string' &&
    typeof record.contractId === 'string' &&
    typeof record.contractDigest === 'string' &&
    Array.isArray(record.definitions) &&
    typeof record.slotId === 'string' &&
    typeof record.sourceHash === 'string' &&
    typeof record.irDigest === 'string' &&
    typeof record.handler === 'string' &&
    record.program !== undefined
  );
}

function digest(program: StructuredProgram): IrDigest {
  return hash('ir', encoder.encode(stringify(program))) as unknown as IrDigest;
}

/**
 * Creates the private executable value used by source execution and the in-memory cache.
 * @internal
 */
export function createVerifiedCompilation(program: VerifiedStructuredProgram, handler: string): VerifiedCompilation {
  return Object.freeze({ digest: digest(program.program), program, handler });
}

/**
 * Serializes a verified compilation only when a caller explicitly requests portable artifact bytes.
 * @internal
 */
export function serializeArtifact(
  request: CheckRequest,
  slot: SlotDefinition,
  compilation: VerifiedCompilation,
  compiler: string,
): CanonicalBytes | undefined {
  const sourceHash = programHash(request.source);
  if (!sourceHash.ok) return undefined;
  const record: ArtifactRecord = {
    magic: 'SafeScript checked artifact',
    format: 2,
    compiler,
    contractId: request.registry.id,
    contractDigest: request.registry.digest,
    definitions: [...request.registry.definitions]
      .map((definition) => [String(definition.id), String(definition.fingerprint)] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
    slotId: slot.id,
    sourceHash: sourceHash.value,
    irDigest: compilation.digest,
    handler: compilation.handler,
    program: compilation.program.program,
  };
  const encoded = encodeCanonical(ARTIFACT_SCHEMA, stringify(record));
  return encoded.ok ? frozenBytes(encoded.value) : undefined;
}

/**
 * Revalidates every compatibility, canonicalisation, fingerprint, digest, and IR invariant before executable use.
 *
 * @remarks Artifact bytes are an untrusted cache input. Verification never treats a prior compilation as current
 * authority and returns `undefined` for every malformed or incompatible form.
 * @internal
 */
export function verifyArtifact(
  bytes: CanonicalBytes,
  registry: ContractRegistry,
  slot: SlotDefinition,
  compiler: string,
): VerifiedCompilation | undefined {
  if (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
    return undefined;
  try {
    const decoded = decodeCanonical(ARTIFACT_SCHEMA, Uint8Array.from(bytes));
    if (!decoded.ok || typeof decoded.value !== 'string') return undefined;
    const text = decoded.value;
    const value = parse(text);
    const definitions = [...registry.definitions]
      .map((definition) => [String(definition.id), String(definition.fingerprint)] as const)
      .sort((left, right) => left[0].localeCompare(right[0]));
    // Re-stringifying rejects alternate JSON spellings before any decoded field gains semantic meaning.
    if (
      !isRecord(value) ||
      stringify(value) !== text ||
      value.compiler !== compiler ||
      value.contractId !== registry.id ||
      value.contractDigest !== registry.digest ||
      stringify(value.definitions) !== stringify(definitions) ||
      value.slotId !== slot.id
    )
      return undefined;
    const required = value.definitions.map(([id, fingerprint]) => ({
      id: id as ContractRegistry['definitions'][number]['id'],
      fingerprint: fingerprint as ContractRegistry['definitions'][number]['fingerprint'],
    }));
    if (checkDefinitionCompatibility(registry, required).length > 0) return undefined;
    const program = verifyProgram(value.program, registry, slot);
    const irDigest = program && digest(program.program);
    if (!program || irDigest !== value.irDigest) return undefined;
    return Object.freeze({ digest: irDigest, program, handler: value.handler });
  } catch {
    return undefined;
  }
}
