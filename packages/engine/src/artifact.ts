/**
 * Creation and fail-closed verification of disposable checked execution artifacts.
 * @packageDocumentation
 */
import {
  LANGUAGE_PROFILE,
  decodeCanonical,
  encodeCanonical,
  hash,
  programHash,
  sourceHash,
  type CanonicalBytes,
  type CheckRequest,
  type ContractRegistry,
  type IrDigest,
  type Schema,
  type Sha256Digest,
  type SlotDefinition,
} from '@safescript/contracts';

import { verifyProgram, type StructuredProgram, type VerifiedStructuredProgram } from './structured-ir.js';

const encoder = new TextEncoder();
const ARTIFACT_SCHEMA: Schema = Object.freeze({ kind: 'string' });
const ARTIFACT_FORMAT = 3;

/** Exact compiler-semantics identity used by artifacts and cache keys. */
export const COMPILER_BUILD = 'structured-ir-current';

interface ArtifactRecord {
  readonly magic: 'SafeScript checked artifact';
  readonly format: 3;
  readonly compiler: string;
  readonly contractDigest: string;
  readonly slotId: string;
  readonly artifactKey: string;
  readonly irDigest: string;
  readonly syntaxNodes: number;
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
  readonly syntaxNodes: number;
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
    record.format === ARTIFACT_FORMAT &&
    typeof record.compiler === 'string' &&
    typeof record.contractDigest === 'string' &&
    typeof record.slotId === 'string' &&
    typeof record.artifactKey === 'string' &&
    typeof record.irDigest === 'string' &&
    typeof record.syntaxNodes === 'number' &&
    Number.isSafeInteger(record.syntaxNodes) &&
    record.syntaxNodes >= 0 &&
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
export function createVerifiedCompilation(
  program: VerifiedStructuredProgram,
  handler: string,
  syntaxNodes: number,
): VerifiedCompilation {
  return Object.freeze({ digest: digest(program.program), program, handler, syntaxNodes });
}

/** Derives the opaque non-secret key used by an optional host artifact store. */
export function artifactKey(request: CheckRequest): Sha256Digest | undefined {
  const source = programHash(request.source);
  if (!source.ok) return undefined;
  return hash(
    'artifact',
    encoder.encode(
      stringify({
        format: ARTIFACT_FORMAT,
        compiler: COMPILER_BUILD,
        language: LANGUAGE_PROFILE,
        contractDigest: request.registry.digest,
        slotId: request.slotId,
        programHash: source.value,
        modules: request.source.modules.map((module) => ({
          id: module.id,
          hash: sourceHash(Uint8Array.from(module.source)),
        })),
        limits: request.limits,
      }),
    ),
  );
}

/**
 * Serializes a verified compilation only when a caller explicitly requests portable artifact bytes.
 * @internal
 */
export function serializeArtifact(
  request: CheckRequest,
  slot: SlotDefinition,
  compilation: VerifiedCompilation,
): CanonicalBytes | undefined {
  const key = artifactKey(request);
  if (!key) return undefined;
  const record: ArtifactRecord = {
    magic: 'SafeScript checked artifact',
    format: ARTIFACT_FORMAT,
    compiler: COMPILER_BUILD,
    contractDigest: request.registry.digest,
    slotId: slot.id,
    artifactKey: key,
    irDigest: compilation.digest,
    syntaxNodes: compilation.syntaxNodes,
    program: compilation.program.program,
  };
  const encoded = encodeCanonical(ARTIFACT_SCHEMA, stringify(record));
  return encoded.ok ? frozenBytes(encoded.value) : undefined;
}

/**
 * Revalidates every compatibility, canonicalisation, binding, digest, and IR invariant before executable use.
 *
 * @remarks Artifact bytes are an untrusted cache input. Verification never treats a prior compilation as current
 * authority and returns `undefined` for every malformed or incompatible form.
 * @internal
 */
export function verifyArtifact(
  bytes: CanonicalBytes,
  registry: ContractRegistry,
  slot: SlotDefinition,
  expectedKey?: Sha256Digest,
): VerifiedCompilation | undefined {
  if (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
    return undefined;
  try {
    const decoded = decodeCanonical(ARTIFACT_SCHEMA, Uint8Array.from(bytes));
    if (!decoded.ok || typeof decoded.value !== 'string') return undefined;
    const text = decoded.value;
    const value = parse(text);
    // Re-stringifying rejects alternate JSON spellings before any decoded field gains semantic meaning.
    if (
      !isRecord(value) ||
      stringify(value) !== text ||
      value.compiler !== COMPILER_BUILD ||
      value.contractDigest !== registry.digest ||
      value.slotId !== slot.id ||
      !/^[0-9a-f]{64}$/.test(value.artifactKey) ||
      (expectedKey !== undefined && value.artifactKey !== expectedKey)
    )
      return undefined;
    const program = verifyProgram(value.program, registry, slot);
    const irDigest = program && digest(program.program);
    if (!program || irDigest !== value.irDigest) return undefined;
    return Object.freeze({
      digest: irDigest,
      program,
      handler: program.program.handler,
      syntaxNodes: value.syntaxNodes,
    });
  } catch {
    return undefined;
  }
}
