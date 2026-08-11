/**
 * Transport-neutral direct bridge orchestration for checking, inspection, execution, actions, cancellation, and close.
 *
 * @packageDocumentation
 */
import {
  decodeCanonical,
  encodeCanonical,
  diagnosticRepair,
  hash,
  ids,
  isActionOutcome,
  isApplySemanticEditsRequest,
  isSemanticEditCapabilityViewRequest,
  programHash,
  resultSchema,
  sourceHash,
  type ActionOutcome,
  type ActionRequest,
  type ActionRecord,
  type ApplySemanticEditsRequest,
  type ApplySemanticEditsResult,
  type BridgeError,
  type CanonicalBytes,
  type CanonicalValue,
  type CheckRequest,
  type CheckResult,
  type CloseResult,
  type CompileLimits,
  type CompileUsage,
  type CompilerDiagnosticCode,
  type ContractRegistry,
  type ExecutionFacts,
  type ExecutionErrorCode,
  type ExecutionLimits,
  type ExecutionPreparation,
  type ExecutionResult,
  type ExecutionUsage,
  type InspectRequest,
  type InspectResult,
  type InspectViewRequest,
  type InspectViewResult,
  type OperationDefinition,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type Schema,
  type SlotDefinition,
  type SourceLocation,
  type TypeId,
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_SEMANTIC_GRAPH_LIMITS,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  SEMANTIC_GRAPH_SCHEMA,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_FAILURE_DETAIL_LENGTH,
  LANGUAGE_PROFILE,
} from '@safescript/contracts';

import {
  COMPILER_BUILD,
  artifactKey,
  createVerifiedCompilation,
  serializeArtifact,
  verifyArtifact,
  type VerifiedCompilation,
} from './artifact.js';
import {
  CompilationCache,
  STANDARD_COMPILATION_CACHE_LIMITS,
  type CompilationCacheLimits,
} from './compilation-cache.js';
import { compileProgram, measureCompilerSource } from './compiler.js';
import { interpret, InterpreterFault } from './interpreter.js';
import { allocationFuel, byteFuel, hostActionFuel, scanFuel, SEMANTIC_STEP_FUEL } from './resource-schedule.js';
import { verifyProgram, type StructuredAction } from './structured-ir.js';
import { deriveSemanticGraph } from './semantic-graph.js';
import { buildSemanticGraph } from './semantic-graph.js';
import { deriveSemanticEditCapabilities } from './semantic-capabilities.js';
import { applySemanticEditKernel } from './semantic-gestures.js';
import { buildSemanticDiff } from './semantic-diff.js';
import { SemanticModelLimitError } from './semantic-model.js';

const COMPILER = Object.freeze({
  build: COMPILER_BUILD,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Compiled {
  readonly compilation: VerifiedCompilation;
  readonly usage: CompileUsage;
  readonly slot: SlotDefinition;
  readonly weight: number;
}

type RejectedCheck = Extract<CheckResult, { readonly status: 'rejected' }>;
type InternalCheckResult =
  | RejectedCheck
  | Extract<CheckResult, { readonly status: 'bridge_error' }>
  | Readonly<{ status: 'accepted'; compiled: Compiled }>;

interface ActiveInvocation {
  cancelled: boolean;
  readonly cancellationListeners: Set<() => void>;
}

interface MutableUsage {
  fuel: number;
  allocations: number;
  allocatedBytes: number;
  peakCollectionItems: number;
  peakValueDepth: number;
  peakValueNodes: number;
  peakValueBytes: number;
  peakCallDepth: number;
  hostCalls: number;
  traceBytes: number;
  outputBytes: number;
}

interface ValueLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

class ExecutionFault extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

function bridgeError(phase: BridgeError['phase'], code: BridgeError['code'], detail?: string): BridgeError {
  return Object.freeze({
    code,
    phase,
    ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_FAILURE_DETAIL_LENGTH) }),
  });
}

function frozenBytes(bytes: Uint8Array | readonly number[]): CanonicalBytes {
  return Object.freeze(Array.from(bytes));
}

function isByteArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function decodeSource(bytes: CanonicalBytes): string | undefined {
  if (!isByteArray(bytes)) return undefined;
  try {
    const source = decoder.decode(Uint8Array.from(bytes));
    return encoder.encode(source).length === bytes.length ? source : undefined;
  } catch {
    return undefined;
  }
}

function diagnostic(request: CheckRequest, code: CompilerDiagnosticCode, message: string, start = 0, end = 0) {
  return Object.freeze({
    code,
    severity: 'error' as const,
    message: message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    repair: Object.freeze(diagnosticRepair(code)),
    location: Object.freeze({ module: request.source.module, start, end }),
  });
}

function findType(registry: ContractRegistry, id: TypeId): Schema | undefined {
  return registry.schemas.types.find((definition) => definition.id === id)?.schema;
}

function validateRegistry(registry: ContractRegistry, slotId: CheckRequest['slotId']): SlotDefinition | string {
  const slot = registry.slots.find((candidate) => candidate.id === slotId);
  if (!slot) return 'unknown extension slot';
  if (!findType(registry, slot.input) || !findType(registry, slot.output)) return 'slot references an unknown schema';
  for (const operation of registry.operations) {
    if (
      !findType(registry, operation.input) ||
      !findType(registry, operation.output) ||
      !findType(registry, operation.error)
    )
      return `operation ${operation.id} references an unknown schema`;
    if (!Number.isSafeInteger(operation.effectCost) || operation.effectCost < 0 || operation.effectCost > 2_147_483_647)
      return `operation ${operation.id} has an invalid effect cost`;
  }
  return slot;
}

function usage(sourceBytes: number, syntaxNodes = 0): CompileUsage {
  return Object.freeze({ sourceBytes, syntaxNodes });
}

function compileLimitsValid(limits: CompileLimits, ceiling: CompileLimits): boolean {
  const keys = Object.keys(STANDARD_COMPILE_LIMITS) as (keyof CompileLimits)[];
  const numericKeys = keys.filter((key) => key !== 'includeDiagnostics') as Exclude<
    keyof CompileLimits,
    'includeDiagnostics'
  >[];
  return (
    Object.keys(limits).every((key) => key in STANDARD_COMPILE_LIMITS) &&
    Object.keys(ceiling).every((key) => key in STANDARD_COMPILE_LIMITS) &&
    Object.keys(limits).length === keys.length &&
    Object.keys(ceiling).length === keys.length &&
    typeof limits.includeDiagnostics === 'boolean' &&
    typeof ceiling.includeDiagnostics === 'boolean' &&
    (!limits.includeDiagnostics || ceiling.includeDiagnostics) &&
    numericKeys.every(
      (key) =>
        Number.isSafeInteger(limits[key]) &&
        Number.isSafeInteger(ceiling[key]) &&
        limits[key] >= 0 &&
        ceiling[key] >= 0 &&
        limits[key] <= ceiling[key] &&
        limits[key] <= STANDARD_COMPILE_LIMITS[key],
    )
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Validates the whole tagged view envelope before nested values are read. */
function inspectViewValid(value: unknown): value is InspectViewRequest {
  if (isSemanticEditCapabilityViewRequest(value)) return true;
  if (!exactRecord(value, ['kind', 'schema', 'limits']) || value.kind !== 'semantic_graph') return false;
  if (
    !exactRecord(value.schema, ['major', 'minor']) ||
    value.schema.major !== SEMANTIC_GRAPH_SCHEMA.major ||
    value.schema.minor !== SEMANTIC_GRAPH_SCHEMA.minor
  )
    return false;
  const limits = value.limits;
  if (!exactRecord(limits, ['nodes', 'edges', 'bytes'])) return false;
  return (Object.keys(STANDARD_SEMANTIC_GRAPH_LIMITS) as (keyof typeof STANDARD_SEMANTIC_GRAPH_LIMITS)[]).every(
    (key) => {
      const selected = limits[key];
      return (
        typeof selected === 'number' &&
        Number.isSafeInteger(selected) &&
        selected >= 0 &&
        selected <= STANDARD_SEMANTIC_GRAPH_LIMITS[key]
      );
    },
  );
}

function cacheText(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(cacheText).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${cacheText(item)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('unsupported cache key value');
  return encoded;
}

type AcceptedCheck = Extract<CheckResult, { readonly status: 'accepted' }>;

function projectAcceptedCheck(request: CheckRequest, compiled: Compiled): AcceptedCheck | RejectedCheck {
  const artifact = request.includeArtifact
    ? serializeArtifact(request, compiled.slot, compiled.compilation)
    : undefined;
  if (request.includeArtifact && !artifact)
    return Object.freeze({
      status: 'rejected',
      diagnostics: Object.freeze(
        request.limits.includeDiagnostics
          ? [diagnostic(request, 'SS_COMPILER_LIMIT', 'serialized artifact exceeds its encoding limit')]
          : [],
      ),
      usage: compiled.usage,
    });
  return Object.freeze({
    status: 'accepted',
    ...(artifact === undefined ? {} : { artifact }),
    summary: compiled.compilation.program.program.summary,
    provenance: Object.freeze({ compiler: COMPILER }),
    usage: compiled.usage,
    diagnostics: Object.freeze([]),
  });
}

function compilationCacheKey(request: CheckRequest): string {
  return hash(
    'program',
    encoder.encode(
      cacheText({
        compiler: COMPILER_BUILD,
        language: LANGUAGE_PROFILE,
        registry: request.registry,
        slotId: request.slotId,
        source: {
          module: request.source.module,
          hash: sourceHash(Uint8Array.from(request.source.source)),
        },
        limits: request.limits,
      }),
    ),
  );
}

function checkRequestWithSource(request: CheckRequest, source: CheckRequest['source']): CheckRequest {
  return Object.freeze({
    registry: request.registry,
    slotId: request.slotId,
    source,
    limits: request.limits,
    ...(request.includeArtifact === undefined ? {} : { includeArtifact: request.includeArtifact }),
  });
}

async function checkCompile(
  request: CheckRequest,
  cache: CompilationCache<InternalCheckResult>,
): Promise<InternalCheckResult> {
  const sourceBytes = request.source.source.length;
  let compileUsage = usage(sourceBytes);
  const reject = (code: CompilerDiagnosticCode, message: string, start = 0, end = 0): RejectedCheck =>
    Object.freeze({
      status: 'rejected',
      diagnostics: Object.freeze(
        request.limits.includeDiagnostics ? [diagnostic(request, code, message, start, end)] : [],
      ),
      usage: compileUsage,
    });
  if (request.includeArtifact !== undefined && typeof request.includeArtifact !== 'boolean')
    return { status: 'bridge_error', error: bridgeError('check', 'invalid_request', 'invalid artifact selection') };
  if (
    request.cachedArtifact !== undefined &&
    (!isByteArray(request.cachedArtifact) || request.cachedArtifact.length > STANDARD_EXECUTION_LIMITS.maxBytes)
  )
    return { status: 'bridge_error', error: bridgeError('check', 'invalid_request', 'invalid cached artifact') };
  const slot = validateRegistry(request.registry, request.slotId);
  if (typeof slot === 'string') return reject('SS_CONTRACT_INVALID', slot);
  if (!compileLimitsValid(request.limits, slot.compileLimits))
    return reject('SS_COMPILER_LIMIT', 'compile limits exceed the slot ceiling');
  try {
    ids.module(request.source.module);
  } catch {
    return reject('SS_MODULE_SHAPE', 'source module identity is invalid');
  }
  if (sourceBytes > request.limits.sourceBytes) return reject('SS_COMPILER_LIMIT', 'source byte limit exceeded');
  const sourceText = decodeSource(request.source.source);
  if (sourceText === undefined) return reject('SS_SOURCE_ENCODING', 'source must be canonical UTF-8');
  const sourceMeasure = measureCompilerSource(sourceText);
  if (
    sourceMeasure.typeDepth > request.limits.typeDepth ||
    sourceMeasure.derivedTemplateBytes > request.limits.derivedTemplateBytes
  )
    return reject('SS_COMPILER_LIMIT', 'type-depth or derived-template limit exceeded');
  const identity = programHash(request.source);
  if (!identity.ok) return reject('SS_SOURCE_ENCODING', 'source program identity is invalid');
  const key = compilationCacheKey(request);
  return cache.getOrLoad(
    key,
    () => {
      if (request.cachedArtifact !== undefined) {
        const cached = verifyArtifact(request.cachedArtifact, request.registry, slot, artifactKey(request));
        if (cached && cached.syntaxNodes <= request.limits.syntaxNodes) {
          compileUsage = usage(sourceBytes, cached.syntaxNodes);
          return Object.freeze({
            status: 'accepted' as const,
            compiled: Object.freeze({
              compilation: cached,
              usage: compileUsage,
              slot,
              weight: sourceBytes + cached.syntaxNodes * 64,
            }),
          });
        }
      }
      const compiled = compileProgram(sourceText, request.source.module, request.registry, slot);
      compileUsage = usage(sourceBytes, compiled.syntaxNodes);
      if (
        compiled.imports > request.limits.imports ||
        compiled.declarations > request.limits.declarations ||
        compiled.syntaxNodes > request.limits.syntaxNodes ||
        compiled.syntaxDepth > request.limits.syntaxDepth
      )
        return reject('SS_COMPILER_LIMIT', 'import, declaration, or syntax limit exceeded');
      if (!compiled.ok)
        return reject(compiled.failure.code, compiled.failure.message, compiled.failure.start, compiled.failure.end);
      const verified = verifyProgram(compiled.program, request.registry, slot);
      if (!verified) return reject('SS_INTERNAL_IR_INVALID', 'lowered program failed private typed-IR verification');
      return Object.freeze({
        status: 'accepted' as const,
        compiled: Object.freeze({
          compilation: createVerifiedCompilation(verified, compiled.handler, compiled.syntaxNodes),
          usage: compileUsage,
          slot,
          weight: sourceBytes + compiled.syntaxNodes * 64,
        }),
      });
    },
    (result) => (result.status === 'accepted' ? result.compiled.weight : undefined),
  );
}

function compileEditCandidate(
  request: ApplySemanticEditsRequest,
  slot: SlotDefinition,
  source: ApplySemanticEditsRequest['source'],
):
  | Readonly<{ ok: true; compiled: Compiled }>
  | Readonly<{
      ok: false;
      check: RejectedCheck;
      diagnostics: readonly { message: string; start: number; end: number }[];
    }> {
  const candidate = checkRequestWithSource(request, source);
  const sourceText = decodeSource(source.source);
  let compileUsage = usage(source.source.length);
  const reject = (code: CompilerDiagnosticCode, message: string, start = 0, end = 0) =>
    Object.freeze({
      ok: false as const,
      check: Object.freeze({
        status: 'rejected' as const,
        diagnostics: Object.freeze(
          request.limits.includeDiagnostics ? [diagnostic(candidate, code, message, start, end)] : [],
        ),
        usage: compileUsage,
      }),
      diagnostics: Object.freeze([{ message, start, end }]),
    });
  if (sourceText === undefined) return reject('SS_SOURCE_ENCODING', 'source must be canonical UTF-8');
  if (source.source.length > request.limits.sourceBytes)
    return reject('SS_COMPILER_LIMIT', 'source byte limit exceeded');
  const measure = measureCompilerSource(sourceText);
  if (
    measure.typeDepth > request.limits.typeDepth ||
    measure.derivedTemplateBytes > request.limits.derivedTemplateBytes
  )
    return reject('SS_COMPILER_LIMIT', 'type-depth or derived-template limit exceeded');
  const compiled = compileProgram(sourceText, source.module, request.registry, slot);
  compileUsage = usage(source.source.length, compiled.syntaxNodes);
  if (
    compiled.imports > request.limits.imports ||
    compiled.declarations > request.limits.declarations ||
    compiled.syntaxNodes > request.limits.syntaxNodes ||
    compiled.syntaxDepth > request.limits.syntaxDepth
  )
    return reject('SS_COMPILER_LIMIT', 'import, declaration, or syntax limit exceeded');
  if (!compiled.ok)
    return reject(compiled.failure.code, compiled.failure.message, compiled.failure.start, compiled.failure.end);
  const verified = verifyProgram(compiled.program, request.registry, slot);
  if (!verified) return reject('SS_INTERNAL_IR_INVALID', 'lowered program failed private typed-IR verification');
  return Object.freeze({
    ok: true,
    compiled: Object.freeze({
      compilation: createVerifiedCompilation(verified, compiled.handler, compiled.syntaxNodes),
      usage: compileUsage,
      slot,
      weight: source.source.length + compiled.syntaxNodes * 64,
    }),
  });
}

function deriveViews(
  request: CheckRequest,
  compiled: Compiled,
  views: readonly InspectViewRequest[],
): readonly InspectViewResult[] {
  let graph: ReturnType<typeof buildSemanticGraph> | undefined;
  return Object.freeze(
    views.map((view): InspectViewResult => {
      if (view.kind === 'semantic_graph') {
        const derived = deriveSemanticGraph(request, compiled.slot, compiled.compilation, COMPILER, view.limits);
        if ('graph' in derived) graph = derived.graph;
        return 'bytes' in derived
          ? Object.freeze({ kind: 'semantic_graph', status: 'accepted', bytes: derived.bytes })
          : Object.freeze({ kind: 'semantic_graph', status: 'rejected', error: Object.freeze(derived) });
      }
      graph ??= buildSemanticGraph(request, compiled.slot, compiled.compilation, COMPILER, {
        nodes: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS.targets,
        edges: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS.capabilities,
      });
      const derived = deriveSemanticEditCapabilities(
        request.source,
        graph,
        request.registry,
        compiled.slot,
        view.scope,
        view.limits,
      );
      return 'manifest' in derived
        ? Object.freeze({ kind: 'semantic_edit_capabilities', status: 'accepted', bytes: derived.bytes })
        : Object.freeze({ kind: 'semantic_edit_capabilities', status: 'rejected', error: derived });
    }),
  );
}

function semanticEditUsage(sourceBytes: number) {
  return Object.freeze({
    operations: 0,
    fragmentBytes: 0,
    transformedRegions: 0,
    work: 0,
    provenanceEntries: 0,
    diffBytes: 0,
    sourceBytes,
  });
}

function executionUsage(usageValue: MutableUsage): ExecutionUsage {
  return Object.freeze({ ...usageValue });
}

function facts(
  preparation: ExecutionPreparation,
  records: ActionRecord[],
  usageValue: MutableUsage,
  trace: CanonicalBytes[] = [],
  truncated = false,
): ExecutionFacts {
  return Object.freeze({
    preparation,
    actions: Object.freeze([...records]),
    trace: Object.freeze({ records: Object.freeze([...trace]), truncated }),
    usage: executionUsage(usageValue),
  });
}

function limitsValid(limits: ExecutionLimits, ceiling: ExecutionLimits): boolean {
  const keys = Object.keys(STANDARD_EXECUTION_LIMITS) as (keyof ExecutionLimits)[];
  return (
    Object.keys(limits).every((key) => key in STANDARD_EXECUTION_LIMITS) &&
    keys.every(
      (key) =>
        Number.isSafeInteger(limits[key]) &&
        Number.isSafeInteger(ceiling[key]) &&
        limits[key] >= 0 &&
        ceiling[key] >= 0 &&
        limits[key] <= ceiling[key] &&
        limits[key] <= STANDARD_EXECUTION_LIMITS[key],
    )
  );
}

function schemaRef(type: TypeId): Schema {
  return { kind: 'ref', type };
}

function failedOutcome(
  requestId: ActionOutcome['requestId'],
  code: 'cancelled' | 'invalid_result' | 'gateway_fault' | 'handler_fault',
  effectState: 'not_performed' | 'unknown',
): ActionOutcome {
  return Object.freeze({
    requestId,
    result: Object.freeze({ tag: 'failed', value: Object.freeze({ effectState, failure: Object.freeze({ code }) }) }),
  });
}

function emptyUsage(): MutableUsage {
  return {
    fuel: 0,
    allocations: 0,
    allocatedBytes: 0,
    peakCollectionItems: 0,
    peakValueDepth: 0,
    peakValueNodes: 0,
    peakValueBytes: 0,
    peakCallDepth: 0,
    hostCalls: 0,
    traceBytes: 0,
    outputBytes: 0,
  };
}

function valueLimits(limits: ExecutionLimits, maxBytes = limits.maxBytes): ValueLimits {
  return { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxBytes };
}

function seededRandom(seed: CanonicalBytes | undefined): () => number {
  if (!seed || seed.length === 0)
    return () => {
      throw new InterpreterFault('random_seed_required');
    };
  let state = seed.reduce((value, byte) => Math.imul(value ^ byte, 16_777_619) >>> 0, 2_166_136_261) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

class ExecutionMeter {
  constructor(
    readonly usage: MutableUsage,
    private readonly limits: ExecutionLimits,
    private readonly registry: ContractRegistry,
  ) {}

  charge(fuel: number, allocation?: Readonly<{ value: CanonicalValue; type: Schema }>): void {
    const allocatedBytes = allocation ? this.encodedSize(allocation) : 0;
    const nextFuel = this.usage.fuel + fuel + (allocation ? Math.ceil(allocatedBytes / 16) : 0);
    const nextAllocations = this.usage.allocations + (allocation ? 1 : 0);
    const nextAllocatedBytes = this.usage.allocatedBytes + allocatedBytes;
    const exceeded = [
      nextFuel > this.limits.fuel && 'fuel',
      nextAllocations > this.limits.allocations && 'allocations',
      nextAllocatedBytes > this.limits.allocatedBytes && 'allocatedBytes',
    ].find(Boolean);
    if (exceeded) throw new ExecutionFault('resource_exhausted', String(exceeded));
    Object.assign(this.usage, {
      fuel: nextFuel,
      allocations: nextAllocations,
      allocatedBytes: nextAllocatedBytes,
    });
    if (allocation) this.observe(allocation.value, allocatedBytes);
  }

  allocate(value: CanonicalValue): void {
    const metrics = canonicalMetrics(value);
    this.assertValue(metrics);
    this.chargeRaw(allocationFuel(metrics.bytes), metrics.bytes);
    this.observe(value, metrics.bytes, metrics);
  }

  scan(values: readonly CanonicalValue[]): void {
    const metrics = values.map(canonicalMetrics);
    const nodes = metrics.reduce((total, item) => total + item.nodes, 0);
    const bytes = metrics.reduce((total, item) => total + item.bytes, 0);
    this.charge(scanFuel(nodes, bytes));
    values.forEach((value, index) => {
      const metric = metrics[index] ?? canonicalMetrics(value);
      this.observe(value, metric.bytes, metric);
    });
  }

  observe(value: CanonicalValue, encodedBytes: number, known = canonicalMetrics(value)): void {
    this.assertValue({ ...known, bytes: encodedBytes });
    this.usage.peakValueDepth = Math.max(this.usage.peakValueDepth, known.depth);
    this.usage.peakValueNodes = Math.max(this.usage.peakValueNodes, known.nodes);
    this.usage.peakValueBytes = Math.max(this.usage.peakValueBytes, encodedBytes);
  }

  private assertValue(metrics: Readonly<{ depth: number; nodes: number; bytes: number }>): void {
    if (metrics.depth > this.limits.maxDepth) throw new ExecutionFault('value_limit', 'maxDepth');
    if (metrics.nodes > this.limits.maxNodes) throw new ExecutionFault('value_limit', 'maxNodes');
    if (metrics.bytes > this.limits.maxBytes) throw new ExecutionFault('value_limit', 'maxBytes');
  }

  private chargeRaw(fuel: number, bytes: number): void {
    const nextFuel = this.usage.fuel + fuel;
    const nextAllocations = this.usage.allocations + 1;
    const nextAllocatedBytes = this.usage.allocatedBytes + bytes;
    const exceeded = [
      nextFuel > this.limits.fuel && 'fuel',
      nextAllocations > this.limits.allocations && 'allocations',
      nextAllocatedBytes > this.limits.allocatedBytes && 'allocatedBytes',
    ].find(Boolean);
    if (exceeded) throw new ExecutionFault('resource_exhausted', String(exceeded));
    Object.assign(this.usage, {
      fuel: nextFuel,
      allocations: nextAllocations,
      allocatedBytes: nextAllocatedBytes,
    });
  }

  private encodedSize(allocation: Readonly<{ value: CanonicalValue; type: Schema }>): number {
    const encoded = encodeCanonical(allocation.type, allocation.value, {
      registry: this.registry.schemas,
      limits: valueLimits(this.limits),
    });
    if (!encoded.ok) throw new ExecutionFault('value_limit', encoded.failure.code);
    return encoded.value.length;
  }
}

function cborHead(bytes: number): number {
  return bytes < 24 ? 1 : bytes < 256 ? 2 : bytes < 65_536 ? 3 : bytes < 4_294_967_296 ? 5 : 9;
}

function canonicalMetrics(root: CanonicalValue): Readonly<{ depth: number; nodes: number; bytes: number }> {
  let nodes = 0;
  let bytes = 0;
  let depth = 0;
  const pending: { value: CanonicalValue; depth: number }[] = [{ value: root, depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop() as { value: CanonicalValue; depth: number };
    nodes++;
    depth = Math.max(depth, item.depth);
    if (item.value === null || typeof item.value === 'boolean') bytes += 1;
    else if (typeof item.value === 'number') bytes += 9;
    else if (typeof item.value === 'bigint') {
      const magnitude = item.value >= 0n ? item.value : -1n - item.value;
      bytes +=
        magnitude < 24n ? 1 : magnitude < 256n ? 2 : magnitude < 65_536n ? 3 : magnitude < 4_294_967_296n ? 5 : 9;
    } else if (typeof item.value === 'string') {
      const length = encoder.encode(item.value).length;
      bytes += cborHead(length) + length;
    } else if (Array.isArray(item.value)) {
      bytes += cborHead(item.value.length);
      for (let index = item.value.length - 1; index >= 0; index--)
        pending.push({ value: item.value[index] as CanonicalValue, depth: item.depth + 1 });
    } else {
      const values = Object.values(item.value);
      bytes += cborHead(values.length);
      for (let index = values.length - 1; index >= 0; index--)
        pending.push({ value: values[index] as CanonicalValue, depth: item.depth + 1 });
    }
  }
  return { depth, nodes, bytes };
}

class ExecutionTrace {
  readonly records: CanonicalBytes[] = [];
  truncated = false;

  constructor(
    private readonly enabled: boolean,
    private readonly limit: number,
    private readonly usage: MutableUsage,
  ) {}

  add(event: string, source: SourceLocation): void {
    if (!this.enabled || this.truncated) return;
    const bytes = frozenBytes(encoder.encode(JSON.stringify({ event, source, fuel: this.usage.fuel })));
    if (this.usage.traceBytes + bytes.length > this.limit) {
      this.truncated = true;
      return;
    }
    this.usage.traceBytes += bytes.length;
    this.records.push(bytes);
  }
}

type ExecutionRequest = Parameters<RuntimeBridge['execute']>[0];
type ActionInstruction = StructuredAction;

class ActionDispatcher {
  private sequence = 0;

  constructor(
    private readonly request: ExecutionRequest,
    private readonly host: RuntimeBridgeHost,
    private readonly active: ActiveInvocation,
    private readonly artifact: VerifiedCompilation,
    private readonly records: ActionRecord[],
    private readonly meter: ExecutionMeter,
    private readonly usage: MutableUsage,
  ) {}

  async handle(instruction: ActionInstruction, value: CanonicalValue): Promise<CanonicalValue> {
    if (this.active.cancelled) throw new InterpreterFault('cancelled');
    const operation = this.artifact.program.operations.get(instruction.operationId);
    if (!operation) throw new ExecutionFault('invalid_ir', 'unknown operation');
    const input = this.encodeInput(instruction, value);
    if (this.usage.hostCalls + 1 > this.request.limits.hostCalls)
      throw new ExecutionFault('resource_exhausted', 'hostCalls');
    this.meter.charge(hostActionFuel(operation.effectCost, input.length));
    this.usage.hostCalls++;
    const request = this.createRequest(instruction, operation, input);
    this.records.push(Object.freeze({ phase: 'requested', request }));
    return this.interpretOutcome(request.requestId, operation, await this.receive(request));
  }

  private encodeInput(instruction: ActionInstruction, value: CanonicalValue): CanonicalBytes {
    const encoded = encodeCanonical(instruction.inputType, value, {
      registry: this.request.registry.schemas,
      limits: valueLimits(this.request.limits),
    });
    if (!encoded.ok) throw new ExecutionFault('value_limit', encoded.failure.code);
    return frozenBytes(encoded.value);
  }

  private createRequest(
    instruction: ActionInstruction,
    operation: OperationDefinition,
    input: CanonicalBytes,
  ): ActionRequest {
    const requestId = ids.request(this.request.invocationId, this.sequence);
    this.sequence++;
    return Object.freeze({
      contractId: this.request.registry.id,
      irDigest: this.artifact.digest,
      invocationId: this.request.invocationId,
      requestId,
      slotId: this.request.slotId,
      operationId: operation.id,
      actionSiteId: instruction.actionSiteId,
      source: instruction.source,
      input,
    });
  }

  private async receive(actionRequest: ActionRequest): Promise<unknown> {
    if (this.active.cancelled) return failedOutcome(actionRequest.requestId, 'cancelled', 'not_performed');
    let cancel!: () => void;
    const cancellation = new Promise<ActionOutcome>((resolve) => {
      cancel = () => resolve(failedOutcome(actionRequest.requestId, 'cancelled', 'unknown'));
      this.active.cancellationListeners.add(cancel);
    });
    const dispatched = Promise.resolve()
      .then(() => this.host.handleAction(actionRequest))
      .catch(() => failedOutcome(actionRequest.requestId, 'handler_fault', 'unknown'));
    try {
      return await Promise.race([dispatched, cancellation]);
    } finally {
      this.active.cancellationListeners.delete(cancel);
    }
  }

  private interpretOutcome(
    requestId: ActionOutcome['requestId'],
    operation: OperationDefinition,
    received: unknown,
  ): CanonicalValue {
    if (!isActionOutcome(received, requestId, this.request.limits.maxBytes)) {
      const outcome = failedOutcome(requestId, 'gateway_fault', 'unknown');
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
      throw new ExecutionFault('action_outcome_invalid');
    }
    if (received.result.tag === 'failed') {
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
      throw new ExecutionFault(received.result.value.failure.code, received.result.value.effectState);
    }
    return this.completed(requestId, operation, received);
  }

  private completed(
    requestId: ActionOutcome['requestId'],
    operation: OperationDefinition,
    received: ActionOutcome,
  ): CanonicalValue {
    if (received.result.tag !== 'completed') throw new ExecutionFault('invalid_ir', 'expected completed outcome');
    const decoded = decodeCanonical(
      resultSchema(schemaRef(operation.output), schemaRef(operation.error)),
      Uint8Array.from(received.result.value),
      { registry: this.request.registry.schemas, limits: valueLimits(this.request.limits) },
    );
    if (!decoded.ok) {
      const outcome = failedOutcome(requestId, 'invalid_result', 'unknown');
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
      throw new ExecutionFault('action_outcome_invalid', decoded.failure.code);
    }
    this.meter.scan([decoded.value]);
    this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
    this.meter.allocate(decoded.value);
    return decoded.value;
  }
}

/**
 * Reference in-process implementation of the transport-neutral {@link RuntimeBridge}.
 *
 * @remarks The bridge owns compiler/runtime semantics and action-request formation, but never current host authority or
 * operation handlers. Those remain behind the supplied `RuntimeBridgeHost` adapter.
 */
export interface DirectRuntimeBridgeOptions {
  /** False disables reuse; otherwise omitted fields use the documented bridge-local defaults. */
  readonly compilationCache?: false | Partial<CompilationCacheLimits>;
}

export class DirectRuntimeBridge implements RuntimeBridge {
  private closed = false;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly executions = new Set<Promise<ExecutionResult>>();
  private readonly compilationCache: CompilationCache<InternalCheckResult>;

  constructor(options: DirectRuntimeBridgeOptions = {}) {
    const selected = options.compilationCache;
    this.compilationCache = new CompilationCache(
      selected === false
        ? { maxEntries: 0, maxWeight: 0 }
        : {
            maxEntries: selected?.maxEntries ?? STANDARD_COMPILATION_CACHE_LIMITS.maxEntries,
            maxWeight: selected?.maxWeight ?? STANDARD_COMPILATION_CACHE_LIMITS.maxWeight,
          },
    );
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('check', 'bridge_closed') };
    const result = await checkCompile(request, this.compilationCache);
    if (result.status !== 'accepted') return result;
    return projectAcceptedCheck(request, result.compiled);
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('inspect', 'bridge_closed') };
    if (
      !Array.isArray(request.views) ||
      !request.views.every(inspectViewValid) ||
      new Set(request.views.map((view) => view.kind)).size !== request.views.length
    )
      return { status: 'bridge_error', error: bridgeError('inspect', 'invalid_request', 'invalid view selection') };
    const result = await checkCompile(request, this.compilationCache);
    if (result.status !== 'accepted') return result;
    const check = projectAcceptedCheck(request, result.compiled);
    if (check.status !== 'accepted') return check;
    let views: Extract<InspectResult, { status: 'accepted' }>['views'];
    try {
      views = deriveViews(request, result.compiled, request.views);
    } catch {
      return { status: 'bridge_error', error: bridgeError('inspect', 'adapter_failure') };
    }
    return Object.freeze({
      status: 'accepted',
      check,
      views,
    });
  }

  async applySemanticEdits(request: ApplySemanticEditsRequest): Promise<ApplySemanticEditsResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('apply_semantic_edits', 'bridge_closed') };
    if (!isApplySemanticEditsRequest(request))
      return {
        status: 'bridge_error',
        error: bridgeError('apply_semantic_edits', 'invalid_request', 'invalid semantic edit request'),
      };
    const checked = await checkCompile(request, this.compilationCache);
    if (checked.status === 'bridge_error')
      return {
        status: 'bridge_error',
        error: Object.freeze({ ...checked.error, phase: 'apply_semantic_edits' }),
      };
    if (checked.status === 'rejected')
      return Object.freeze({
        status: 'rejected',
        reason: 'source_rejected',
        diagnostics: checked.diagnostics,
        editDiagnostics: Object.freeze([]),
        editIds: Object.freeze([]),
        targets: Object.freeze([]),
        usage: semanticEditUsage(request.source.source.length),
        compileUsage: checked.usage,
      });

    try {
      const graph = buildSemanticGraph(request, checked.compiled.slot, checked.compiled.compilation, COMPILER, {
        nodes: request.editLimits.work,
        edges: request.editLimits.work,
      });
      let candidate:
        | Extract<ReturnType<typeof compileEditCandidate>, { ok: true }>
        | Extract<ReturnType<typeof compileEditCandidate>, { ok: false }>
        | undefined;
      const transformed = applySemanticEditKernel(
        request.source,
        graph,
        request.baseRevision,
        request.edits,
        request.editLimits,
        (source) => {
          candidate = compileEditCandidate(request, checked.compiled.slot, source);
          return candidate.ok ? { ok: true } : { ok: false, diagnostics: candidate.diagnostics };
        },
      );
      if (transformed.status === 'rejected') {
        const rejectedCandidate = candidate && !candidate.ok ? candidate : undefined;
        return Object.freeze({
          status: 'rejected',
          reason: transformed.reason,
          diagnostics: rejectedCandidate?.check.diagnostics ?? Object.freeze([]),
          editDiagnostics: transformed.editDiagnostics,
          editIds: transformed.editIds,
          targets: transformed.targets,
          usage: transformed.usage,
          ...(transformed.limit ? { limit: transformed.limit } : {}),
          ...(rejectedCandidate ? { compileUsage: rejectedCandidate.check.usage } : {}),
        });
      }
      if (!candidate?.ok) throw new Error('accepted semantic edit has no accepted checked candidate');
      const updatedRequest = checkRequestWithSource(request, transformed.source);
      const finalCheck = projectAcceptedCheck(updatedRequest, candidate.compiled);
      if (finalCheck.status === 'rejected')
        return Object.freeze({
          status: 'rejected',
          reason: 'source_rejected',
          diagnostics: finalCheck.diagnostics,
          editDiagnostics: Object.freeze([]),
          editIds: Object.freeze(request.edits.map((edit) => edit.editId)),
          targets: Object.freeze([]),
          usage: transformed.usage,
          compileUsage: finalCheck.usage,
        });
      const rebuilt = buildSemanticGraph(
        updatedRequest,
        candidate.compiled.slot,
        candidate.compiled.compilation,
        COMPILER,
        { nodes: request.editLimits.work, edges: request.editLimits.work },
      );
      const diff = buildSemanticDiff(graph, rebuilt, request.edits, transformed.changedRegions);
      const diffBytes = encoder.encode(cacheText(diff)).length;
      const finalUsage = Object.freeze({ ...transformed.usage, diffBytes });
      if (diffBytes > request.editLimits.diffBytes)
        return Object.freeze({
          status: 'rejected',
          reason: 'edit_limit_exceeded',
          diagnostics: Object.freeze([]),
          editDiagnostics: Object.freeze([
            Object.freeze({
              code: 'SE_EDIT_LIMIT_EXCEEDED' as const,
              message: 'semantic diff byte limit exceeded',
              editIds: Object.freeze(request.edits.map((edit) => edit.editId)),
              targets: Object.freeze([]),
              related: Object.freeze([]),
            }),
          ]),
          editIds: Object.freeze(request.edits.map((edit) => edit.editId)),
          targets: Object.freeze([]),
          usage: finalUsage,
          limit: Object.freeze({ limit: 'diff_bytes', maximum: request.editLimits.diffBytes, actual: diffBytes }),
        });
      const views = deriveViews(updatedRequest, candidate.compiled, request.views ?? []);
      return Object.freeze({
        status: 'accepted',
        source: transformed.source,
        sourceHash: rebuilt.sourceHash,
        programHash: rebuilt.programHash,
        semanticRevision: rebuilt.semanticRevision,
        check: finalCheck,
        outcomes: transformed.outcomes,
        changedRegions: transformed.changedRegions,
        provenance: transformed.provenance,
        diff,
        usage: finalUsage,
        views,
      });
    } catch (error) {
      if (error instanceof SemanticModelLimitError)
        return Object.freeze({
          status: 'rejected',
          reason: 'edit_limit_exceeded',
          diagnostics: Object.freeze([]),
          editDiagnostics: Object.freeze([]),
          editIds: Object.freeze(request.edits.map((edit) => edit.editId)),
          targets: Object.freeze([]),
          usage: semanticEditUsage(request.source.source.length),
          limit: Object.freeze({ limit: 'work', maximum: request.editLimits.work, actual: error.actual }),
        });
      return { status: 'bridge_error', error: bridgeError('apply_semantic_edits', 'adapter_failure') };
    }
  }

  execute(request: Parameters<RuntimeBridge['execute']>[0], host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (this.closed) return Promise.resolve({ status: 'bridge_error', error: bridgeError('execute', 'bridge_closed') });
    try {
      ids.invocation(request.invocationId);
    } catch {
      return Promise.resolve({
        status: 'not_started',
        error: bridgeError('execute', 'invalid_request', 'invalid invocation identifier'),
      });
    }
    // Invocation IDs are unique only while active; no durable tombstones or replay coordinator are retained.
    if (this.active.has(request.invocationId))
      return Promise.resolve({
        status: 'not_started',
        error: bridgeError('execute', 'invalid_request', 'duplicate active invocation'),
      });
    const active: ActiveInvocation = { cancelled: false, cancellationListeners: new Set() };
    this.active.set(request.invocationId, active);
    const execution = this.run(request, host, active).finally(() => {
      this.active.delete(request.invocationId);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return execution;
  }

  private async run(
    request: Parameters<RuntimeBridge['execute']>[0],
    host: RuntimeBridgeHost,
    active: ActiveInvocation,
  ): Promise<ExecutionResult> {
    const records: ActionRecord[] = [];
    const usageValue = emptyUsage();
    const slot = validateRegistry(request.registry, request.slotId);
    if (
      typeof slot === 'string' ||
      !limitsValid(request.limits, typeof slot === 'string' ? request.limits : slot.executionLimits)
    )
      return {
        status: 'not_started',
        error: bridgeError(
          'execute',
          'invalid_request',
          typeof slot === 'string' ? slot : 'execution limits exceed slot ceiling',
        ),
      };
    if (
      !isByteArray(request.input) ||
      request.input.length > request.limits.maxBytes ||
      (request.randomSeed !== undefined &&
        (!isByteArray(request.randomSeed) || request.randomSeed.length > request.limits.maxBytes)) ||
      typeof request.trace !== 'boolean' ||
      (request.fixedInstant !== undefined &&
        !encodeCanonical({ kind: 'instant' }, request.fixedInstant, {
          limits: valueLimits(request.limits),
        }).ok)
    )
      return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'invalid bounded bytes') };
    let artifact: VerifiedCompilation;
    let preparation: ExecutionPreparation;
    if (request.program.kind === 'source') {
      const compilation = await checkCompile(request.program.source, this.compilationCache);
      if (compilation.status === 'rejected')
        return { status: 'not_started', diagnostics: compilation.diagnostics, usage: compilation.usage };
      if (compilation.status === 'bridge_error') return { status: 'bridge_error', error: compilation.error };
      if (
        request.program.source.registry.digest !== request.registry.digest ||
        request.program.source.slotId !== request.slotId
      )
        return {
          status: 'not_started',
          error: bridgeError('execute', 'invalid_request', 'source compile inputs do not match execution'),
        };
      artifact = compilation.compiled.compilation;
      const projected = projectAcceptedCheck(request.program.source, compilation.compiled);
      if (projected.status !== 'accepted')
        return { status: 'not_started', diagnostics: projected.diagnostics, usage: projected.usage };
      preparation = Object.freeze({
        kind: 'source',
        ...(projected.artifact === undefined ? {} : { artifact: projected.artifact }),
        summary: projected.summary,
        provenance: projected.provenance,
        usage: projected.usage,
        diagnostics: projected.diagnostics,
      });
    } else {
      const verified = verifyArtifact(request.program.bytes, request.registry, slot);
      if (!verified)
        return {
          status: 'not_started',
          error: bridgeError('execute', 'artifact_verification_failed'),
        };
      artifact = verified;
      preparation = Object.freeze({ kind: 'artifact', irDigest: artifact.digest });
    }
    const input = decodeCanonical(schemaRef(slot.input), Uint8Array.from(request.input), {
      registry: request.registry.schemas,
      limits: {
        maxDepth: request.limits.maxDepth,
        maxNodes: request.limits.maxNodes,
        maxBytes: request.limits.maxBytes,
      },
    });
    if (!input.ok)
      return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'slot input is not canonical') };
    const meter = new ExecutionMeter(usageValue, request.limits, request.registry);
    meter.observe(input.value, request.input.length);
    const trace = new ExecutionTrace(request.trace, request.limits.traceBytes, usageValue);
    const dispatcher = new ActionDispatcher(request, host, active, artifact, records, meter, usageValue);
    const random = seededRandom(request.randomSeed);
    let callDepth = 0;
    try {
      trace.add('invocation_started', {
        module: artifact.program.program.source.module as SourceLocation['module'],
        start: 0,
        end: 0,
      });
      const value = await interpret(artifact.program, input.value, {
        charge: (fuel, allocation) => meter.charge(fuel, allocation),
        allocate: (value) => meter.allocate(value),
        scan: (values) => meter.scan(values),
        cancelled: () => active.cancelled,
        trace: (event, source) => trace.add(event, source),
        random,
        fixedInstant: () => request.fixedInstant as CanonicalValue | undefined,
        enterCall: () => {
          if (callDepth + 1 > request.limits.callDepth) throw new ExecutionFault('resource_exhausted', 'callDepth');
          callDepth++;
          usageValue.peakCallDepth = Math.max(usageValue.peakCallDepth, callDepth);
          return () => {
            callDepth--;
          };
        },
        collection: (items) => {
          if (!Number.isSafeInteger(items) || items < 0 || items > request.limits.collectionItems)
            throw new ExecutionFault('resource_exhausted', 'collectionItems');
          usageValue.peakCollectionItems = Math.max(usageValue.peakCollectionItems, items);
        },
        action: (instruction, actionValue) => dispatcher.handle(instruction, actionValue),
      });
      const output = encodeCanonical(schemaRef(slot.output), value, {
        registry: request.registry.schemas,
        limits: valueLimits(request.limits),
      });
      if (!output.ok) throw new ExecutionFault('invalid_output', output.failure.code);
      if (usageValue.outputBytes + output.value.length > request.limits.outputBytes)
        throw new ExecutionFault('resource_exhausted', 'outputBytes');
      meter.observe(value, output.value.length);
      meter.charge(SEMANTIC_STEP_FUEL + byteFuel(output.value.length));
      usageValue.outputBytes += output.value.length;
      return Object.freeze({
        status: 'completed',
        output: frozenBytes(output.value),
        facts: facts(preparation, records, usageValue, trace.records, trace.truncated),
      });
    } catch (error) {
      const fault =
        error instanceof ExecutionFault || error instanceof InterpreterFault
          ? error
          : new ExecutionFault('interpreter_fault');
      const terminalFacts = facts(preparation, records, usageValue, trace.records, trace.truncated);
      return fault.code === 'cancelled'
        ? { status: 'cancelled', error: { code: 'cancelled' }, facts: terminalFacts }
        : {
            status: 'failed',
            error: {
              code: fault.code,
              ...(fault.detail === undefined ? {} : { detail: fault.detail.slice(0, MAX_FAILURE_DETAIL_LENGTH) }),
            },
            facts: terminalFacts,
          };
    }
  }

  async cancel(request: Parameters<RuntimeBridge['cancel']>[0]) {
    if (this.closed) return { status: 'bridge_error' as const, error: bridgeError('cancel', 'bridge_closed') };
    const active = this.active.get(request.invocationId);
    if (!active) return { status: 'not_active' as const };
    active.cancelled = true;
    for (const cancel of active.cancellationListeners) cancel();
    return { status: 'accepted' as const };
  }

  async close(): Promise<CloseResult> {
    if (this.closed) return { status: 'closed' };
    this.closed = true;
    this.compilationCache.clear();
    // Close follows ordinary cancellation semantics so late host results cannot replay or resume an invocation.
    for (const active of this.active.values()) {
      active.cancelled = true;
      for (const cancel of active.cancellationListeners) cancel();
    }
    await Promise.allSettled([...this.executions]);
    return { status: 'closed' };
  }
}
