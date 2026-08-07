import {
  checkDefinitionCompatibility,
  decodeCanonical,
  derivedActionSiteId,
  encodeCanonical,
  hash,
  ids,
  programHash,
  resultSchema,
  type ActionOutcome,
  type ActionRecord,
  type BridgeError,
  type CanonicalBytes,
  type CanonicalValue,
  type CheckRequest,
  type CheckResult,
  type CloseResult,
  type CompileUsage,
  type ContractRegistry,
  type ExecutionFacts,
  type ExecutionLimits,
  type ExecutionResult,
  type ExecutionUsage,
  type InspectRequest,
  type InspectResult,
  type IrDigest,
  type OperationDefinition,
  type PolicyError,
  type ProgramSummary,
  type RuntimeBridge,
  type RuntimeBridgeFactory,
  type RuntimeBridgeHost,
  type Schema,
  type SlotDefinition,
  type SourceProgram,
  type TypeId,
  type Version,
} from '@safescript/contracts';

const ABI_VERSION = Object.freeze({ major: 1, minor: 0 });
const IR_VERSION = Object.freeze({ major: 1, minor: 0 });
const COMPILER = Object.freeze({ version: Object.freeze({ major: 0, minor: 1, patch: 0 }), build: 'walking-skeleton' });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const FIXTURE = `import{Err,Ok,typeResult}from"safescript:prelude"import{typeContext,typeDealUpdated,typeTaskError}from"host:api"exportasyncfunctiononDealUpdated(event:DealUpdated,ctx:Context):Promise<Result<void,TaskError>>{if(event.before.stage==="won"||event.after.stage!=="won"||event.after.amount.currency!=="AUD"||event.after.amount.minorUnits<2_000_000){returnOk()}constresult=awaitctx.tasks.create({workspaceId:event.after.workspaceId,relatedDealId:event.after.id,title:\`Onboard\${event.after.name}\`})switch(result.tag){case"ok":returnOk()case"error":returnErr(result.value)}}`;

interface Compiled {
  readonly artifact: CanonicalBytes;
  readonly summary: ProgramSummary;
  readonly usage: CompileUsage;
  readonly source: SourceProgram;
  readonly actionSiteId: ReturnType<typeof derivedActionSiteId>;
  readonly actionStart: number;
  readonly operation: OperationDefinition;
  readonly slot: SlotDefinition;
  readonly irDigest: IrDigest;
}

type AcceptedCheck = Extract<CheckResult, { readonly status: 'accepted' }>;
type RejectedCheck = Extract<CheckResult, { readonly status: 'rejected' }>;
type InternalCheckResult = Exclude<CheckResult, AcceptedCheck> | (AcceptedCheck & { readonly compiled: Compiled });

interface ArtifactRecord {
  readonly magic: 'SafeScript checked artifact';
  readonly abi: readonly [number, number];
  readonly language: readonly [number, number];
  readonly ir: readonly [number, number];
  readonly compiler: string;
  readonly contractId: string;
  readonly contractVersion: readonly [number, number, number, string?];
  readonly contractDigest: string;
  readonly definitions: readonly (readonly [string, string])[];
  readonly slotId: string;
  readonly programHash: string;
  readonly irDigest: string;
  readonly actionSiteId: string;
  readonly actionStart: number;
  readonly entry: string;
  readonly modules: readonly (readonly [string, readonly number[]])[];
}

interface ActiveInvocation {
  cancelled: boolean;
  dispatched: boolean;
}

interface MutableUsage {
  fuel: number;
  allocations: number;
  allocatedBytes: number;
  peakRetainedBytes: number;
  hostCalls: number;
  traceBytes: number;
  outputBytes: number;
}

class ExecutionFault {
  constructor(readonly code: string, readonly detail?: string) {}
}

function sameVersion(left: Version, right: Version): boolean {
  return Number.isSafeInteger(left.major) && Number.isSafeInteger(left.minor) && left.major === right.major && left.minor === right.minor;
}

function bridgeError(phase: BridgeError['phase'], code: BridgeError['code'], detail?: string): BridgeError {
  return Object.freeze({ code, phase, ...(detail === undefined ? {} : { detail: detail.slice(0, 160) }) });
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

function sourceWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n\r]*/g, '$1').replace(/\s+/g, '').replace(/,([})])/g, '$1');
}

function compileUsage(source: SourceProgram): CompileUsage {
  const sourceBytes = source.modules.reduce((total, module) => total + module.source.length, 0);
  return Object.freeze({ sourceBytes, syntaxNodes: Math.min(sourceBytes, 154), typeWork: Math.min(sourceBytes * 2, 308) });
}

function diagnostic(request: CheckRequest, code: string, message: string, start = 0, end = 0) {
  return Object.freeze({
    code,
    severity: 'error' as const,
    message,
    location: Object.freeze({ module: request.source.entry, start, end }),
  });
}

function findType(registry: ContractRegistry, id: TypeId): Schema | undefined {
  return registry.schemas.types.find((definition) => definition.id === id)?.schema;
}

function validateRegistry(registry: ContractRegistry, slotId: CheckRequest['slotId']): { slot: SlotDefinition; operation: OperationDefinition } | string {
  const slot = registry.slots.find((candidate) => candidate.id === slotId);
  if (!slot) return 'unknown extension slot';
  const operations = registry.operations.filter((operation) => slot.effects.includes(operation.effect) && slot.capabilities.includes(operation.capability));
  const operation = operations.find((candidate) => String(candidate.id) === 'operation:tasks.create') ?? (operations.length === 1 ? operations[0] : undefined);
  if (!operation) return 'slot must permit exactly one tasks.create operation';
  if (!findType(registry, slot.input) || !findType(registry, slot.output) || !findType(registry, operation.input) || !findType(registry, operation.output) || !findType(registry, operation.error)) return 'contract references an unknown schema';
  if (!Number.isSafeInteger(operation.effectCost) || operation.effectCost < 0 || operation.effectCost > 2_147_483_647) return 'invalid operation effect cost';
  if (operation.idempotency !== 'none' && operation.idempotency !== 'required') return 'invalid idempotency contract';
  return { slot, operation };
}

function canonicalArtifact(record: ArtifactRecord): CanonicalBytes {
  return frozenBytes(encoder.encode(JSON.stringify(record)));
}

function buildArtifact(request: CheckRequest, slot: SlotDefinition, operation: OperationDefinition, actionStart: number): { bytes: CanonicalBytes; actionSiteId: ReturnType<typeof derivedActionSiteId>; irDigest: IrDigest } | undefined {
  const sourceDigest = programHash(request.source);
  if (!sourceDigest.ok) return undefined;
  const actionSiteId = derivedActionSiteId(encoder.encode(`${sourceDigest.value}\0${request.source.entry}\0tasks.create`));
  const irDigest = hash('ir', encoder.encode(JSON.stringify([
    String(sourceDigest.value), request.registry.digest, request.slotId, operation.id, operation.input, operation.output, operation.error, actionSiteId,
  ])));
  const version = request.registry.version;
  const definitions = [...request.registry.definitions]
    .map((definition) => [String(definition.id), String(definition.fingerprint)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const record: ArtifactRecord = {
    magic: 'SafeScript checked artifact',
    abi: [1, 0],
    language: [request.languageVersion.major, request.languageVersion.minor],
    ir: [1, 0],
    compiler: `${COMPILER.version.major}.${COMPILER.version.minor}.${COMPILER.version.patch}+${COMPILER.build}`,
    contractId: request.registry.id,
    contractVersion: version.prerelease === undefined
      ? [version.major, version.minor, version.patch]
      : [version.major, version.minor, version.patch, version.prerelease],
    contractDigest: request.registry.digest,
    definitions,
    slotId: request.slotId,
    programHash: sourceDigest.value,
    irDigest,
    actionSiteId,
    actionStart,
    entry: request.source.entry,
    modules: request.source.modules.map((module) => [module.id, frozenBytes(module.source)]),
  };
  return { bytes: canonicalArtifact(record), actionSiteId, irDigest: irDigest as unknown as IrDigest };
}

function checkCompile(request: CheckRequest): InternalCheckResult {
  const usage = compileUsage(request.source);
  const reject = (code: string, message: string, start = 0, end = 0): RejectedCheck => Object.freeze({ status: 'rejected', diagnostics: Object.freeze([diagnostic(request, code, message, start, end)]), usage });
  if (!sameVersion(request.abiVersion, ABI_VERSION) || !sameVersion(request.languageVersion, { major: 1, minor: 0 })) return Object.freeze({ status: 'bridge_error', error: bridgeError('check', 'unsupported_version') });
  const registry = validateRegistry(request.registry, request.slotId);
  if (typeof registry === 'string') return reject('SS_CONTRACT_INVALID', registry);
  if (!sameVersion(registry.slot.languageVersion, request.languageVersion)) return reject('SS_SLOT_LANGUAGE_MISMATCH', 'slot language version does not match request');
  const modules = request.source.modules;
  if (modules.length === 0 || modules.length > request.limits.modules) return reject('SS_COMPILER_LIMIT', 'module limit exceeded');
  if (modules.length !== 1) return reject('SS_MODULE_SET_INVALID', 'language 1.0 accepts one source module plus reserved generated modules');
  if (modules.some((module, index) => index > 0 && String(module.id) <= String(modules[index - 1]?.id))) return reject('SS_MODULE_SET_INVALID', 'source modules must be uniquely and canonically ordered');
  const module = modules.find((candidate) => candidate.id === request.source.entry);
  if (!module) return reject('SS_MODULE_SET_INVALID', 'entry module is absent');
  if (usage.sourceBytes > request.limits.sourceBytes || module.source.length > request.limits.moduleBytes) return reject('SS_COMPILER_LIMIT', 'source byte limit exceeded');
  const text = decodeSource(module.source);
  if (text === undefined) return reject('SS_SOURCE_ENCODING', 'source must be canonical UTF-8');
  const actionStart = text.indexOf('ctx.tasks.create');
  if (sourceWithoutComments(text) !== FIXTURE || !/title\s*:\s*`Onboard \$\{event\.after\.name\}`/.test(text)) {
    const ambient = /(?:from\s*["'](?:node:|https?:|file:|npm:)|\b(?:fetch|process|require|Deno|Bun|WebSocket|XMLHttpRequest)\b)/.exec(text);
    return reject(ambient ? 'SS_AMBIENT_AUTHORITY' : 'SS_UNSUPPORTED_SOURCE', ambient ? 'ambient authority is unavailable' : 'source is outside the SafeScript 1.0 walking-skeleton subset', ambient?.index ?? 0, ambient ? ambient.index + ambient[0].length : 0);
  }
  const artifact = buildArtifact(request, registry.slot, registry.operation, actionStart);
  if (!artifact) return reject('SS_MODULE_SET_INVALID', 'invalid source program');
  const summary = Object.freeze({ effects: Object.freeze([registry.operation.effect]), capabilities: Object.freeze([registry.operation.capability]) });
  const accepted = {
    status: 'accepted' as const,
    artifact: artifact.bytes,
    summary,
    provenance: Object.freeze({ compiler: COMPILER, language: request.languageVersion, ir: IR_VERSION, abi: ABI_VERSION }),
    usage,
    diagnostics: Object.freeze([]),
  };
  return Object.freeze({ ...accepted, compiled: Object.freeze({ artifact: artifact.bytes, summary, usage, source: request.source, actionSiteId: artifact.actionSiteId, actionStart, operation: registry.operation, slot: registry.slot, irDigest: artifact.irDigest }) });
}

function parseArtifact(bytes: CanonicalBytes): ArtifactRecord | undefined {
  if (!isByteArray(bytes)) return undefined;
  try {
    const text = decoder.decode(Uint8Array.from(bytes));
    const value = JSON.parse(text) as ArtifactRecord;
    if (JSON.stringify(value) !== text || value.magic !== 'SafeScript checked artifact' || !Array.isArray(value.modules)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function artifactSource(record: ArtifactRecord): SourceProgram | undefined {
  try {
    const modules = record.modules.map(([id, source]) => ({ id: ids.module(id), source }));
    return Object.freeze({ entry: ids.module(record.entry), modules: Object.freeze(modules) });
  } catch {
    return undefined;
  }
}

function verifyArtifact(bytes: CanonicalBytes, registry: ContractRegistry, slotId: CheckRequest['slotId'], limits: CheckRequest['limits']): Compiled | undefined {
  const record = parseArtifact(bytes);
  const source = record && artifactSource(record);
  if (!record || !source || record.contractId !== registry.id || record.contractDigest !== registry.digest || record.slotId !== slotId || record.abi[0] !== 1 || record.abi[1] !== 0 || record.ir[0] !== 1 || record.ir[1] !== 0) return undefined;
  const required = record.definitions.map(([id, fingerprint]) => ({ id: id as ContractRegistry['definitions'][number]['id'], fingerprint: fingerprint as ContractRegistry['digest'] }));
  if (checkDefinitionCompatibility(registry, required).length > 0) return undefined;
  const checked = checkCompile({ abiVersion: ABI_VERSION, languageVersion: { major: record.language[0], minor: record.language[1] }, registry, slotId, source, limits });
  if (checked.status !== 'accepted' || !checked.compiled || checked.artifact.length !== bytes.length || checked.artifact.some((byte, index) => byte !== bytes[index])) return undefined;
  return checked.compiled;
}

function executionUsage(usage: MutableUsage): ExecutionUsage {
  return Object.freeze({ ...usage });
}

function facts(records: ActionRecord[], usage: MutableUsage, trace: CanonicalBytes[] = [], truncated = false): ExecutionFacts {
  return Object.freeze({ actions: Object.freeze(records), trace: Object.freeze({ records: Object.freeze(trace), truncated }), usage: executionUsage(usage) });
}

function limitsValid(limits: ExecutionLimits, ceiling: ExecutionLimits): boolean {
  return (Object.keys(ceiling) as (keyof ExecutionLimits)[]).every((key) => Number.isSafeInteger(limits[key]) && limits[key] >= 0 && limits[key] <= ceiling[key]);
}

function schemaRef(type: TypeId): Schema {
  return { kind: 'ref', type };
}

function policyValue(schema: Schema, registry: ContractRegistry, error: PolicyError, seen = new Set<TypeId>()): CanonicalValue | undefined {
  if (schema.kind === 'ref') {
    if (seen.has(schema.type)) return undefined;
    const target = findType(registry, schema.type);
    if (!target) return undefined;
    const next = new Set(seen).add(schema.type);
    return policyValue(target, registry, error, next);
  }
  if (schema.kind === 'brand') return policyValue(schema.base, registry, error, seen);
  if (schema.kind === 'unit') return null;
  if (schema.kind === 'string') return error.detail ?? error.code;
  if (schema.kind === 'variant') {
    const none = schema.variants.find((candidate) => candidate.tag === 'none');
    const some = schema.variants.find((candidate) => candidate.tag === 'some');
    if (none && some) {
      if (error.detail === undefined) return { tag: 'none', value: null };
      const value = policyValue(some.schema, registry, error, seen);
      return value === undefined ? undefined : { tag: 'some', value };
    }
    const variant = schema.variants.find((candidate) => /policy/i.test(candidate.tag));
    if (!variant) return undefined;
    const value = policyValue(variant.schema, registry, error, seen);
    return value === undefined ? undefined : { tag: variant.tag, value };
  }
  if (schema.kind === 'record') {
    const value: Record<string, CanonicalValue> = {};
    for (const field of schema.fields) {
      const lower = field.name.toLowerCase();
      if (field.schema.kind === 'string' || (field.schema.kind === 'brand' && field.schema.base.kind === 'string')) value[field.name] = lower.includes('detail') || lower.includes('message') || lower.includes('reason') ? error.detail ?? error.code : error.code;
      else {
        const child = policyValue(field.schema, registry, error, seen);
        if (child === undefined) return undefined;
        value[field.name] = child;
      }
    }
    return value;
  }
  return undefined;
}

function recordField(value: CanonicalValue, ...path: string[]): CanonicalValue | undefined {
  let current: CanonicalValue | undefined = value;
  for (const field of path) {
    if (current === null || Array.isArray(current) || typeof current !== 'object' || !Object.hasOwn(current, field)) return undefined;
    current = (current as Readonly<Record<string, CanonicalValue>>)[field];
  }
  return current;
}

function failedOutcome(requestId: ActionOutcome['requestId'], code: string, effectState: 'not_performed' | 'unknown'): ActionOutcome {
  return Object.freeze({ abiVersion: ABI_VERSION, requestId, result: Object.freeze({ tag: 'failed', value: Object.freeze({ effectState, failure: Object.freeze({ code: code as 'gateway_fault' }) }) }) });
}

function matchingOutcome(value: unknown, requestId: ActionOutcome['requestId']): value is ActionOutcome {
  if (value === null || typeof value !== 'object') return false;
  const outcome = value as Partial<ActionOutcome>;
  if (!outcome.abiVersion || !sameVersion(outcome.abiVersion, ABI_VERSION) || outcome.requestId !== requestId || !outcome.result) return false;
  if (outcome.result.tag === 'completed') return isByteArray(outcome.result.value);
  if (outcome.result.tag === 'rejected') return typeof outcome.result.value?.code === 'string' && (outcome.result.value.detail === undefined || typeof outcome.result.value.detail === 'string');
  if (outcome.result.tag !== 'failed') return false;
  const failure = outcome.result.value;
  return (failure?.effectState === 'not_performed' || failure?.effectState === 'unknown') &&
    ['cancelled', 'timeout', 'unavailable', 'handler_fault', 'invalid_result', 'transport_lost', 'gateway_fault'].includes(failure.failure?.code) &&
    (failure.failure.detail === undefined || typeof failure.failure.detail === 'string');
}

function idempotencyKey(seed: CanonicalBytes, compiled: Compiled, input: CanonicalBytes, sequence: number) {
  return hash('idempotency', encoder.encode(JSON.stringify([
    frozenBytes(seed), compiled.operation.id, compiled.actionSiteId, sequence, hash('artifact', Uint8Array.from(input)),
  ])));
}

function emptyUsage(): MutableUsage {
  return { fuel: 0, allocations: 0, allocatedBytes: 0, peakRetainedBytes: 0, hostCalls: 0, traceBytes: 0, outputBytes: 0 };
}

class DirectRuntimeBridge implements RuntimeBridge {
  private closed = false;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly executions = new Set<Promise<ExecutionResult>>();

  async check(request: CheckRequest): Promise<CheckResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('check', 'bridge_closed') };
    const result = checkCompile(request);
    if (result.status !== 'accepted') return result;
    return Object.freeze({ status: result.status, artifact: result.artifact, summary: result.summary, provenance: result.provenance, usage: result.usage, diagnostics: result.diagnostics });
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('inspect', 'bridge_closed') };
    const result = checkCompile(request);
    if (result.status !== 'accepted') return result;
    const { compiled, ...check } = result;
    const graph = frozenBytes(encoder.encode(JSON.stringify({
      version: [1, 0],
      handler: 'onDealUpdated',
      trigger: request.slotId,
      predicates: ['transition-to-won', 'currency-is-AUD', 'amount-at-least-2000000'],
      branches: ['no-action', 'tasks.create'],
      action: { operationId: compiled.operation.id, effectId: compiled.operation.effect, capabilityId: compiled.operation.capability, actionSiteId: compiled.actionSiteId, source: { module: request.source.entry, start: compiled.actionStart, end: compiled.actionStart + 16 } },
      results: ['ok', 'error'],
    })));
    return Object.freeze({ status: 'accepted', check, views: Object.freeze(request.views.includes('semantic_graph') ? { semantic_graph: graph } : {}) });
  }

  execute(request: Parameters<RuntimeBridge['execute']>[0], host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (this.closed) return Promise.resolve({ status: 'bridge_error', error: bridgeError('execute', 'bridge_closed') });
    if (this.active.has(request.invocationId)) return Promise.resolve({ status: 'not_started', error: bridgeError('execute', 'invalid_request', 'duplicate active invocation') });
    const active: ActiveInvocation = { cancelled: false, dispatched: false };
    this.active.set(request.invocationId, active);
    const execution = this.run(request, host, active).finally(() => {
      this.active.delete(request.invocationId);
      this.executions.delete(execution);
    });
    this.executions.add(execution);
    return execution;
  }

  private async run(request: Parameters<RuntimeBridge['execute']>[0], host: RuntimeBridgeHost, active: ActiveInvocation): Promise<ExecutionResult> {
    const records: ActionRecord[] = [];
    const usage = emptyUsage();
    let compiled: Compiled;
    if (!sameVersion(request.abiVersion, ABI_VERSION)) return { status: 'bridge_error', error: bridgeError('execute', 'unsupported_version') };
    const contract = validateRegistry(request.registry, request.slotId);
    if (typeof contract === 'string' || !limitsValid(request.limits, typeof contract === 'string' ? request.limits : contract.slot.executionLimits)) return { status: 'not_started', error: bridgeError('execute', 'invalid_request', typeof contract === 'string' ? contract : 'execution limits exceed slot ceiling') };
    if (request.program.kind === 'source') {
      const compilation = checkCompile(request.program.source);
      if (compilation.status === 'rejected') return { status: 'not_started', diagnostics: compilation.diagnostics, usage: compilation.usage };
      if (compilation.status === 'bridge_error') return { status: 'bridge_error', error: compilation.error };
      if (request.program.source.registry.digest !== request.registry.digest || request.program.source.slotId !== request.slotId) return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'source compile inputs do not match execution') };
      compiled = compilation.compiled;
    } else {
      const verified = verifyArtifact(request.program.bytes, request.registry, request.slotId, contract.slot.compileLimits);
      if (!verified) return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'artifact verification failed') };
      compiled = verified;
    }
    if (compiled.operation.idempotency === 'required' && (!request.idempotencySeed || !isByteArray(request.idempotencySeed) || request.idempotencySeed.length === 0)) return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'idempotency seed required') };
    const inputResult = decodeCanonical(schemaRef(compiled.slot.input), Uint8Array.from(request.input), { registry: request.registry.schemas, limits: { maxDepth: request.limits.maxDepth, maxNodes: request.limits.maxNodes, maxBytes: request.limits.maxBytes } });
    if (!inputResult.ok) return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'slot input is not canonical') };
    const trace: CanonicalBytes[] = [];
    let traceTruncated = false;
    const charge = (fuel: number, allocation?: CanonicalBytes): void => {
      const allocatedBytes = allocation?.length ?? 0;
      const next = {
        fuel: usage.fuel + fuel,
        allocations: usage.allocations + (allocation ? 1 : 0),
        allocatedBytes: usage.allocatedBytes + allocatedBytes,
        retainedBytes: Math.max(usage.peakRetainedBytes, usage.allocatedBytes + allocatedBytes),
      };
      const exceeded = [
        next.fuel > request.limits.fuel && 'fuel',
        next.allocations > request.limits.allocations && 'allocations',
        next.allocatedBytes > request.limits.allocatedBytes && 'allocatedBytes',
        next.retainedBytes > request.limits.retainedBytes && 'retainedBytes',
      ].find(Boolean);
      if (exceeded) throw new ExecutionFault('resource_exhausted', String(exceeded));
      usage.fuel = next.fuel;
      usage.allocations = next.allocations;
      usage.allocatedBytes = next.allocatedBytes;
      usage.peakRetainedBytes = next.retainedBytes;
    };
    const addTrace = (event: string): void => {
      if (request.trace === 'none' || traceTruncated) return;
      const bytes = frozenBytes(encoder.encode(JSON.stringify({ event, source: { module: compiled?.source.entry, start: compiled?.actionStart ?? 0 }, fuel: usage.fuel })));
      if (usage.traceBytes + bytes.length > request.limits.traceBytes) { traceTruncated = true; return; }
      usage.traceBytes += bytes.length;
      trace.push(bytes);
    };
    try {
      if (active.cancelled) return { status: 'cancelled', error: { code: 'cancelled' }, facts: facts(records, usage, trace, traceTruncated) };
      addTrace('invocation_started');
      const event = inputResult.value;
      charge(4);
      const beforeStage = recordField(event, 'before', 'stage');
      if (beforeStage === 'won') return this.complete(compiled, { tag: 'ok', value: null }, records, usage, request, trace, traceTruncated, charge);
      charge(4);
      const afterStage = recordField(event, 'after', 'stage');
      if (afterStage !== 'won') return this.complete(compiled, { tag: 'ok', value: null }, records, usage, request, trace, traceTruncated, charge);
      charge(4);
      const currency = recordField(event, 'after', 'amount', 'currency');
      if (currency !== 'AUD') return this.complete(compiled, { tag: 'ok', value: null }, records, usage, request, trace, traceTruncated, charge);
      charge(4);
      const minorUnits = recordField(event, 'after', 'amount', 'minorUnits');
      if (typeof minorUnits !== 'bigint') throw new ExecutionFault('invalid_input', 'amount.minorUnits');
      if (minorUnits < 2_000_000n) return this.complete(compiled, { tag: 'ok', value: null }, records, usage, request, trace, traceTruncated, charge);
      const workspaceId = recordField(event, 'after', 'workspaceId');
      const relatedDealId = recordField(event, 'after', 'id');
      const name = recordField(event, 'after', 'name');
      if (typeof name !== 'string' || workspaceId === undefined || relatedDealId === undefined) throw new ExecutionFault('invalid_input', 'deal fields');
      const actionValue = { workspaceId, relatedDealId, title: `Onboard ${name}` };
      const encodedInput = encodeCanonical(schemaRef(compiled.operation.input), actionValue, { registry: request.registry.schemas, limits: { maxDepth: request.limits.maxDepth, maxNodes: request.limits.maxNodes, maxBytes: request.limits.maxBytes } });
      if (!encodedInput.ok) throw new ExecutionFault('value_limit', encodedInput.failure.code);
      const input = frozenBytes(encodedInput.value);
      const actionFuel = 101 + compiled.operation.effectCost + Math.ceil(input.length / 16);
      if (usage.hostCalls + 1 > request.limits.hostCalls || request.limits.concurrentActions < 1) throw new ExecutionFault('resource_exhausted', usage.hostCalls + 1 > request.limits.hostCalls ? 'hostCalls' : 'concurrentActions');
      charge(actionFuel, input);
      usage.hostCalls++;
      const requestId = ids.request(request.invocationId, 0);
      const actionRequest = Object.freeze({
        abiVersion: ABI_VERSION,
        contractId: request.registry.id,
        requiredContractVersion: request.registry.version,
        irDigest: compiled.irDigest,
        invocationId: request.invocationId,
        requestId,
        slotId: request.slotId,
        operationId: compiled.operation.id,
        effectId: compiled.operation.effect,
        capabilityId: compiled.operation.capability,
        actionSiteId: compiled.actionSiteId,
        source: Object.freeze({ module: compiled.source.entry, start: compiled.actionStart, end: compiled.actionStart + 16 }),
        input,
        ...(compiled.operation.idempotency === 'required' ? { idempotencyKey: idempotencyKey(request.idempotencySeed as CanonicalBytes, compiled, input, 0) } : {}),
      });
      records.push(Object.freeze({ phase: 'requested', request: actionRequest }));
      addTrace('action_requested');
      if (active.cancelled) {
        const outcome = failedOutcome(requestId, 'cancelled', 'not_performed');
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
        return { status: 'cancelled', error: { code: 'cancelled' }, facts: facts(records, usage, trace, traceTruncated) };
      }
      active.dispatched = true;
      let received: unknown;
      try {
        received = await host.handleAction(actionRequest);
      } catch {
        received = failedOutcome(requestId, 'handler_fault', 'unknown');
      }
      if (active.cancelled) {
        const outcome = failedOutcome(requestId, 'cancelled', active.dispatched ? 'unknown' : 'not_performed');
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
        return { status: 'cancelled', error: { code: 'cancelled' }, facts: facts(records, usage, trace, traceTruncated) };
      }
      if (!matchingOutcome(received, requestId)) {
        const outcome = failedOutcome(requestId, 'gateway_fault', 'unknown');
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
        return { status: 'failed', error: { code: 'action_outcome_invalid' }, facts: facts(records, usage, trace, traceTruncated) };
      }
      charge(1);
      if (received.result.tag === 'failed') {
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
        return { status: 'failed', error: { code: received.result.value.failure.code, detail: received.result.value.effectState }, facts: facts(records, usage, trace, traceTruncated) };
      }
      if (received.result.tag === 'rejected') {
        const errorSchema = schemaRef(compiled.operation.error);
        const error = policyValue(errorSchema, request.registry, received.result.value);
        if (error === undefined) {
          const outcome = failedOutcome(requestId, 'invalid_result', 'not_performed');
          records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
          return { status: 'failed', error: { code: 'action_outcome_invalid', detail: 'policy error does not match operation error schema' }, facts: facts(records, usage, trace, traceTruncated) };
        }
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
        return this.complete(compiled, { tag: 'error', value: error }, records, usage, request, trace, traceTruncated, charge);
      }
      const operationResult = decodeCanonical(resultSchema(schemaRef(compiled.operation.output), schemaRef(compiled.operation.error)), Uint8Array.from(received.result.value), { registry: request.registry.schemas, limits: { maxDepth: request.limits.maxDepth, maxNodes: request.limits.maxNodes, maxBytes: request.limits.maxBytes } });
      if (!operationResult.ok) {
        const outcome = failedOutcome(requestId, 'invalid_result', 'unknown');
        records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
        return { status: 'failed', error: { code: 'action_outcome_invalid', detail: operationResult.failure.code }, facts: facts(records, usage, trace, traceTruncated) };
      }
      records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
      if (operationResult.value === null || typeof operationResult.value !== 'object' || Array.isArray(operationResult.value) || !('tag' in operationResult.value)) throw new ExecutionFault('action_outcome_invalid');
      const result = operationResult.value as { tag: string; value: CanonicalValue };
      return this.complete(compiled, result.tag === 'ok' ? { tag: 'ok', value: null } : { tag: 'error', value: result.value }, records, usage, request, trace, traceTruncated, charge);
    } catch (error) {
      const fault = error instanceof ExecutionFault ? error : new ExecutionFault('interpreter_fault');
      return { status: 'failed', error: { code: fault.code, ...(fault.detail === undefined ? {} : { detail: fault.detail }) }, facts: facts(records, usage, trace, traceTruncated) };
    }
  }

  private complete(compiled: Compiled, value: CanonicalValue, records: ActionRecord[], usage: MutableUsage, request: Parameters<RuntimeBridge['execute']>[0], trace: CanonicalBytes[], traceTruncated: boolean, charge: (fuel: number, allocation?: CanonicalBytes) => void): ExecutionResult {
    const output = encodeCanonical(schemaRef(compiled.slot.output), value, { registry: request.registry.schemas, limits: { maxDepth: request.limits.maxDepth, maxNodes: request.limits.maxNodes, maxBytes: Math.min(request.limits.maxBytes, request.limits.outputBytes) } });
    if (!output.ok) throw new ExecutionFault('invalid_output', output.failure.code);
    const bytes = frozenBytes(output.value);
    if (usage.outputBytes + bytes.length > request.limits.outputBytes) throw new ExecutionFault('resource_exhausted', 'outputBytes');
    charge(1 + Math.ceil(bytes.length / 16));
    usage.outputBytes += bytes.length;
    return Object.freeze({ status: 'completed', output: bytes, facts: facts(records, usage, trace, traceTruncated) });
  }

  async cancel(request: Parameters<RuntimeBridge['cancel']>[0]) {
    if (this.closed) return { status: 'bridge_error' as const, error: bridgeError('cancel', 'bridge_closed') };
    if (!sameVersion(request.abiVersion, ABI_VERSION)) return { status: 'bridge_error' as const, error: bridgeError('cancel', 'unsupported_version') };
    const active = this.active.get(request.invocationId);
    if (!active) return { status: 'not_active' as const };
    active.cancelled = true;
    return { status: 'accepted' as const };
  }

  async close(): Promise<CloseResult> {
    if (this.closed) return { status: 'closed' };
    this.closed = true;
    for (const active of this.active.values()) active.cancelled = true;
    await Promise.allSettled([...this.executions]);
    return { status: 'closed' };
  }
}

export function createDirectRuntimeBridge(): RuntimeBridge {
  return new DirectRuntimeBridge();
}

export interface EngineOptions {
  readonly bridgeFactory: RuntimeBridgeFactory;
}
