/**
 * Transport-neutral direct bridge orchestration for checking, inspection, execution, actions, cancellation, and close.
 *
 * @packageDocumentation
 */
import {
  decodeCanonical,
  deriveIdempotencyKey,
  encodeCanonical,
  diagnosticRepair,
  ids,
  isActionOutcome,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type ActionRecord,
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
  type ModuleId,
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
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_FAILURE_DETAIL_LENGTH,
} from '@safescript/contracts';

import { createArtifact, verifyArtifact, type CheckedArtifact } from './artifact.js';
import { compileProgramModules, measureCompilerSource } from './compiler.js';
import { interpret, InterpreterFault } from './interpreter.js';
import { verifyProgram, type IrTerminator } from './ir.js';
import { structuredActions } from './structured-ir.js';
import { deriveSemanticGraph } from './semantic-graph.js';

const COMPILER = Object.freeze({
  build: 'typed-ir-current',
});
const COMPILER_NAME = COMPILER.build;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Compiled {
  readonly artifact: CheckedArtifact;
  readonly usage: CompileUsage;
  readonly slot: SlotDefinition;
}

type AcceptedCheck = Extract<CheckResult, { readonly status: 'accepted' }>;
type RejectedCheck = Extract<CheckResult, { readonly status: 'rejected' }>;
type InternalCheckResult = Exclude<CheckResult, AcceptedCheck> | (AcceptedCheck & { readonly compiled: Compiled });

interface ActiveInvocation {
  cancelled: boolean;
  readonly cancellationListeners: Set<() => void>;
}

interface MutableUsage {
  fuel: number;
  allocations: number;
  allocatedBytes: number;
  peakRetainedBytes: number;
  peakCollectionItems: number;
  peakValueDepth: number;
  peakValueNodes: number;
  peakValueBytes: number;
  peakCallDepth: number;
  hostCalls: number;
  peakConcurrentActions: number;
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
    location: Object.freeze({ module: request.source.entry, start, end }),
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
  return Object.freeze({ sourceBytes, syntaxNodes, typeWork: syntaxNodes * 2 });
}

function compileLimitsValid(limits: CompileLimits, ceiling: CompileLimits): boolean {
  const keys = Object.keys(STANDARD_COMPILE_LIMITS) as (keyof CompileLimits)[];
  return (
    Object.keys(limits).every((key) => key in STANDARD_COMPILE_LIMITS) &&
    keys.every(
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

function checkCompile(request: CheckRequest): InternalCheckResult {
  const sourceBytes = request.source.modules.reduce((total, module) => total + module.source.length, 0);
  let compileUsage = usage(sourceBytes);
  const reject = (code: CompilerDiagnosticCode, message: string, start = 0, end = 0): RejectedCheck =>
    Object.freeze({
      status: 'rejected',
      diagnostics: Object.freeze(
        request.limits.diagnostics > 0 ? [diagnostic(request, code, message, start, end)] : [],
      ),
      usage: compileUsage,
    });
  const slot = validateRegistry(request.registry, request.slotId);
  if (typeof slot === 'string') return reject('SS_CONTRACT_INVALID', slot);
  if (!compileLimitsValid(request.limits, slot.compileLimits))
    return reject('SS_COMPILER_LIMIT', 'compile limits exceed the slot ceiling');
  if (
    request.source.modules.length === 0 ||
    request.source.modules.length > request.limits.modules ||
    request.source.modules.length === 0
  )
    return reject('SS_MODULE_SET_INVALID', 'module set is outside the selected language minor');
  const module = request.source.modules.find((candidate) => candidate.id === request.source.entry);
  if (!module) return reject('SS_MODULE_SET_INVALID', 'entry module is absent');
  if (
    sourceBytes > request.limits.sourceBytes ||
    request.source.modules.some((candidate) => candidate.source.length > request.limits.moduleBytes)
  )
    return reject('SS_COMPILER_LIMIT', 'source byte limit exceeded');
  const texts = request.source.modules.map((candidate) => ({
    id: candidate.id,
    source: decodeSource(candidate.source),
  }));
  if (texts.some((candidate) => candidate.source === undefined))
    return reject('SS_SOURCE_ENCODING', 'source must be canonical UTF-8');
  const sourceMeasures = texts.map((candidate) => measureCompilerSource(candidate.source as string));
  if (
    sourceMeasures.some(
      (measure) =>
        measure.typeDepth > request.limits.typeDepth ||
        measure.derivedTemplateBytes > request.limits.derivedTemplateBytes,
    )
  )
    return reject('SS_COMPILER_LIMIT', 'type-depth or derived-template limit exceeded');
  const compiled = compileProgramModules(
    texts as readonly Readonly<{ id: ModuleId; source: string }>[],
    request.source.entry,
    request.registry,
    slot,
  );
  compileUsage = usage(sourceBytes, compiled.syntaxNodes);
  if (
    compiled.imports > request.limits.imports ||
    compiled.declarations > request.limits.declarations ||
    compiled.syntaxNodes > request.limits.syntaxNodes ||
    compiled.syntaxDepth > request.limits.syntaxDepth ||
    compileUsage.typeWork > request.limits.typeInstantiationWork
  )
    return reject('SS_COMPILER_LIMIT', 'import, declaration, syntax, or type-work limit exceeded');
  if (!compiled.ok)
    return reject(compiled.failure.code, compiled.failure.message, compiled.failure.start, compiled.failure.end);
  const verified = verifyProgram(compiled.program, request.registry, slot);
  if (!verified) return reject('SS_INTERNAL_IR_INVALID', 'lowered program failed private typed-IR verification');
  const artifact = createArtifact(request, slot, verified, compiled.handler, COMPILER_NAME);
  if (!artifact) return reject('SS_MODULE_SET_INVALID', 'source program identity is invalid');
  const accepted = Object.freeze({
    status: 'accepted' as const,
    artifact: artifact.bytes,
    summary: artifact.program.program.summary,
    provenance: Object.freeze({
      compiler: COMPILER,
    }),
    usage: compileUsage,
    diagnostics: Object.freeze([]),
  });
  return Object.freeze({ ...accepted, compiled: Object.freeze({ artifact, usage: compileUsage, slot }) });
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
    peakRetainedBytes: 0,
    peakCollectionItems: 0,
    peakValueDepth: 0,
    peakValueNodes: 0,
    peakValueBytes: 0,
    peakCallDepth: 0,
    hostCalls: 0,
    peakConcurrentActions: 0,
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
    const nextRetainedBytes = Math.max(this.usage.peakRetainedBytes, nextAllocatedBytes);
    const exceeded = [
      nextFuel > this.limits.fuel && 'fuel',
      nextAllocations > this.limits.allocations && 'allocations',
      nextAllocatedBytes > this.limits.allocatedBytes && 'allocatedBytes',
      nextRetainedBytes > this.limits.retainedBytes && 'retainedBytes',
    ].find(Boolean);
    if (exceeded) throw new ExecutionFault('resource_exhausted', String(exceeded));
    Object.assign(this.usage, {
      fuel: nextFuel,
      allocations: nextAllocations,
      allocatedBytes: nextAllocatedBytes,
      peakRetainedBytes: nextRetainedBytes,
    });
    if (allocation) this.observe(allocation.value, allocatedBytes);
  }

  allocate(value: CanonicalValue): void {
    const metrics = canonicalMetrics(value);
    this.assertValue(metrics);
    this.chargeRaw(4 + Math.ceil(metrics.bytes / 16), metrics.bytes);
    this.observe(value, metrics.bytes, metrics);
  }

  scan(values: readonly CanonicalValue[]): void {
    const metrics = values.map(canonicalMetrics);
    const nodes = metrics.reduce((total, item) => total + item.nodes, 0);
    const bytes = metrics.reduce((total, item) => total + item.bytes, 0);
    this.charge(2 * nodes + Math.ceil(bytes / 16));
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
    const nextRetainedBytes = Math.max(this.usage.peakRetainedBytes, nextAllocatedBytes);
    const exceeded = [
      nextFuel > this.limits.fuel && 'fuel',
      nextAllocations > this.limits.allocations && 'allocations',
      nextAllocatedBytes > this.limits.allocatedBytes && 'allocatedBytes',
      nextRetainedBytes > this.limits.retainedBytes && 'retainedBytes',
    ].find(Boolean);
    if (exceeded) throw new ExecutionFault('resource_exhausted', String(exceeded));
    Object.assign(this.usage, {
      fuel: nextFuel,
      allocations: nextAllocations,
      allocatedBytes: nextAllocatedBytes,
      peakRetainedBytes: nextRetainedBytes,
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

function actionInstructions(artifact: CheckedArtifact): Extract<IrTerminator, { tag: 'action' }>[] {
  return artifact.program.program.blocks.flatMap((block) =>
    block.terminator.tag === 'action'
      ? [block.terminator]
      : block.terminator.tag === 'structured'
        ? structuredActions(block.terminator.program).map((action) => ({
            ...action,
            tag: 'action' as const,
            input: '',
            resume: '',
          }))
        : [],
  );
}

type ExecutionRequest = Parameters<RuntimeBridge['execute']>[0];
type ActionInstruction = Extract<IrTerminator, { tag: 'action' }>;

class ActionDispatcher {
  private sequence = 0;

  constructor(
    private readonly request: ExecutionRequest,
    private readonly host: RuntimeBridgeHost,
    private readonly active: ActiveInvocation,
    private readonly artifact: CheckedArtifact,
    private readonly records: ActionRecord[],
    private readonly meter: ExecutionMeter,
    private readonly usage: MutableUsage,
  ) {}

  async handle(instruction: ActionInstruction, value: CanonicalValue): Promise<CanonicalValue> {
    const results = await this.handleGroup([{ instruction, input: value }]);
    return results[0] as CanonicalValue;
  }

  async handleGroup(
    actions: readonly Readonly<{ instruction: ActionInstruction; input: CanonicalValue }>[],
  ): Promise<readonly CanonicalValue[]> {
    if (this.active.cancelled) throw new InterpreterFault('cancelled');
    const prepared = actions.map(({ instruction, input: value }) => {
      const operation = this.artifact.program.operations.get(instruction.operationId);
      if (!operation) throw new ExecutionFault('invalid_ir', 'unknown operation');
      return { instruction, operation, input: this.encodeInput(instruction, value) };
    });
    this.assertHostCapacity(prepared.length);
    // A group is one atomic semantic operation: no request is observable unless
    // every member's host-call reservation and fuel charge can be committed.
    this.meter.charge(
      prepared.reduce((fuel, item) => fuel + 100 + item.operation.effectCost + Math.ceil(item.input.length / 16), 0),
    );
    this.usage.hostCalls += prepared.length;
    this.usage.peakConcurrentActions = Math.max(this.usage.peakConcurrentActions, prepared.length);
    const pending = prepared.map((item) => ({
      ...item,
      request: this.createRequest(item.instruction, item.operation, item.input),
    }));
    for (const item of pending) this.records.push(Object.freeze({ phase: 'requested', request: item.request }));

    // Dispatch only after deterministic request creation/recording. Outcomes are
    // attached in input order, irrespective of host completion order.
    const received = await Promise.all(pending.map((item) => this.receive(item.request)));
    const values: CanonicalValue[] = [];
    let firstFault: unknown;
    for (const [index, item] of pending.entries()) {
      try {
        values.push(this.interpretOutcome(item.request.requestId, item.operation, received[index]));
      } catch (error) {
        if (firstFault === undefined) firstFault = error;
        values.push(null);
      }
    }
    if (firstFault !== undefined) throw firstFault;
    return Object.freeze(values);
  }

  private encodeInput(instruction: ActionInstruction, value: CanonicalValue): CanonicalBytes {
    const encoded = encodeCanonical(instruction.inputType, value, {
      registry: this.request.registry.schemas,
      limits: valueLimits(this.request.limits),
    });
    if (!encoded.ok) throw new ExecutionFault('value_limit', encoded.failure.code);
    return frozenBytes(encoded.value);
  }

  private assertHostCapacity(count: number): void {
    if (this.usage.hostCalls + count > this.request.limits.hostCalls || count > this.request.limits.concurrentActions)
      throw new ExecutionFault(
        'resource_exhausted',
        this.usage.hostCalls + count > this.request.limits.hostCalls ? 'hostCalls' : 'concurrentActions',
      );
  }

  private createRequest(
    instruction: ActionInstruction,
    operation: OperationDefinition,
    input: CanonicalBytes,
  ): ActionRequest {
    const requestId = ids.request(this.request.invocationId, this.sequence);
    const key =
      operation.idempotency === 'required'
        ? deriveIdempotencyKey({
            seed: this.request.idempotencySeed as CanonicalBytes,
            contractId: this.request.registry.id,
            operationId: operation.id,
            actionSiteId: instruction.actionSiteId,
            sequence: this.sequence,
            actionInput: input,
          })
        : undefined;
    if (key && !key.ok) throw new ExecutionFault('idempotency_key_invalid', key.failure.code);
    this.sequence++;
    return Object.freeze({
      contractId: this.request.registry.id,
      irDigest: this.artifact.digest,
      invocationId: this.request.invocationId,
      requestId,
      slotId: this.request.slotId,
      operationId: operation.id,
      effectId: operation.effect,
      capabilityId: operation.capability,
      actionSiteId: instruction.actionSiteId,
      source: instruction.source,
      input,
      ...(key?.ok ? { idempotencyKey: key.value } : {}),
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
export class DirectRuntimeBridge implements RuntimeBridge {
  private closed = false;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly executions = new Set<Promise<ExecutionResult>>();

  async check(request: CheckRequest): Promise<CheckResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('check', 'bridge_closed') };
    const result = checkCompile(request);
    if (result.status !== 'accepted') return result;
    return Object.freeze({
      status: result.status,
      artifact: result.artifact,
      summary: result.summary,
      provenance: result.provenance,
      usage: result.usage,
      diagnostics: result.diagnostics,
    });
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    if (this.closed) return { status: 'bridge_error', error: bridgeError('inspect', 'bridge_closed') };
    if (
      !Array.isArray(request.views) ||
      request.views.some((view) => view !== 'semantic_graph') ||
      new Set(request.views).size !== request.views.length
    )
      return { status: 'bridge_error', error: bridgeError('inspect', 'invalid_request', 'invalid view selection') };
    const graphLimits = request.graphLimits ?? STANDARD_SEMANTIC_GRAPH_LIMITS;
    if (
      Object.keys(graphLimits).length !== 3 ||
      (Object.keys(STANDARD_SEMANTIC_GRAPH_LIMITS) as (keyof typeof STANDARD_SEMANTIC_GRAPH_LIMITS)[]).some(
        (key) =>
          !Number.isSafeInteger(graphLimits[key]) ||
          graphLimits[key] < 0 ||
          graphLimits[key] > STANDARD_SEMANTIC_GRAPH_LIMITS[key],
      )
    )
      return { status: 'bridge_error', error: bridgeError('inspect', 'invalid_request', 'invalid graph limits') };
    const result = checkCompile(request);
    if (result.status !== 'accepted') return result;
    const check: AcceptedCheck = Object.freeze({
      status: result.status,
      artifact: result.artifact,
      summary: result.summary,
      provenance: result.provenance,
      usage: result.usage,
      diagnostics: result.diagnostics,
    });
    let graph: ReturnType<typeof deriveSemanticGraph> | undefined;
    try {
      graph = request.views.includes('semantic_graph')
        ? deriveSemanticGraph(request, result.compiled.slot, result.compiled.artifact, COMPILER, graphLimits)
        : undefined;
    } catch {
      return { status: 'bridge_error', error: bridgeError('inspect', 'adapter_failure') };
    }
    return Object.freeze({
      status: 'accepted',
      check,
      views: Object.freeze(graph !== undefined && 'bytes' in graph ? { semantic_graph: graph.bytes } : {}),
      viewErrors: Object.freeze(graph !== undefined && 'code' in graph ? { semantic_graph: Object.freeze(graph) } : {}),
    });
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
      (request.idempotencySeed !== undefined &&
        (!isByteArray(request.idempotencySeed) || request.idempotencySeed.length > request.limits.maxBytes)) ||
      (request.randomSeed !== undefined &&
        (!isByteArray(request.randomSeed) || request.randomSeed.length > request.limits.maxBytes)) ||
      !['none', 'summary', 'semantic'].includes(request.trace) ||
      (request.fixedInstant !== undefined &&
        !encodeCanonical({ kind: 'instant' }, request.fixedInstant, {
          limits: valueLimits(request.limits),
        }).ok)
    )
      return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'invalid bounded bytes') };
    let artifact: CheckedArtifact;
    let preparation: ExecutionPreparation;
    if (request.program.kind === 'source') {
      const compilation = checkCompile(request.program.source);
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
      artifact = compilation.compiled.artifact;
      preparation = Object.freeze({
        kind: 'source',
        artifact: compilation.artifact,
        summary: compilation.summary,
        provenance: compilation.provenance,
        usage: compilation.usage,
        diagnostics: compilation.diagnostics,
      });
    } else {
      const verified = verifyArtifact(request.program.bytes, request.registry, slot, COMPILER_NAME);
      if (!verified)
        return {
          status: 'not_started',
          error: bridgeError('execute', 'artifact_verification_failed'),
        };
      artifact = verified;
      preparation = Object.freeze({ kind: 'artifact', irDigest: artifact.digest });
    }
    const actions = actionInstructions(artifact);
    if (
      actions.some((action) => artifact.program.operations.get(action.operationId)?.idempotency === 'required') &&
      (!request.idempotencySeed || !isByteArray(request.idempotencySeed) || request.idempotencySeed.length === 0)
    )
      return { status: 'not_started', error: bridgeError('execute', 'invalid_request', 'idempotency seed required') };
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
    const trace = new ExecutionTrace(request.trace !== 'none', request.limits.traceBytes, usageValue);
    const dispatcher = new ActionDispatcher(request, host, active, artifact, records, meter, usageValue);
    const random = seededRandom(request.randomSeed);
    let callDepth = 0;
    try {
      trace.add('invocation_started', {
        module: artifact.program.program.blocks[0]?.terminator.source.module as SourceLocation['module'],
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
        actionGroup: (group) => dispatcher.handleGroup(group),
      });
      const output = encodeCanonical(schemaRef(slot.output), value, {
        registry: request.registry.schemas,
        limits: valueLimits(request.limits),
      });
      if (!output.ok) throw new ExecutionFault('invalid_output', output.failure.code);
      if (usageValue.outputBytes + output.value.length > request.limits.outputBytes)
        throw new ExecutionFault('resource_exhausted', 'outputBytes');
      meter.observe(value, output.value.length);
      meter.charge(1 + Math.ceil(output.value.length / 16));
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
    // Close follows ordinary cancellation semantics so late host results cannot replay or resume an invocation.
    for (const active of this.active.values()) {
      active.cancelled = true;
      for (const cancel of active.cancellationListeners) cancel();
    }
    await Promise.allSettled([...this.executions]);
    return { status: 'closed' };
  }
}
