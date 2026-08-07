/**
 * Transport-neutral direct bridge orchestration for checking, inspection, execution, actions, cancellation, and close.
 *
 * @packageDocumentation
 */
import {
  decodeCanonical,
  deriveIdempotencyKey,
  encodeCanonical,
  ids,
  policyErrorValue,
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
  type ContractRegistry,
  type ExecutionFacts,
  type ExecutionLimits,
  type ExecutionPreparation,
  type ExecutionResult,
  type ExecutionUsage,
  type InspectRequest,
  type InspectResult,
  type OperationDefinition,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type Schema,
  type SlotDefinition,
  type SourceLocation,
  type TypeId,
  type Version,
} from '@safescript/contracts';

import { createArtifact, verifyArtifact, type CheckedArtifact } from './artifact.js';
import { compileProgram } from './compiler.js';
import { interpret, InterpreterFault } from './interpreter.js';
import { verifyProgram, type IrTerminator } from './ir.js';

const ABI_VERSION = Object.freeze({ major: 1, minor: 0 });
const IR_VERSION = Object.freeze({ major: 1, minor: 0 });
const COMPILER = Object.freeze({
  version: Object.freeze({ major: 0, minor: 1, patch: 0 }),
  build: 'typed-ir-walking-skeleton',
});
const COMPILER_NAME = `${COMPILER.version.major}.${COMPILER.version.minor}.${COMPILER.version.patch}+${COMPILER.build}`;
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

interface ValueLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

class ExecutionFault extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

function sameVersion(left: Version, right: Version): boolean {
  return (
    Number.isSafeInteger(left.major) &&
    Number.isSafeInteger(left.minor) &&
    left.major === right.major &&
    left.minor === right.minor
  );
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
  return (Object.keys(ceiling) as (keyof CompileLimits)[]).every(
    (key) => Number.isSafeInteger(limits[key]) && limits[key] >= 0 && limits[key] <= ceiling[key],
  );
}

function checkCompile(request: CheckRequest): InternalCheckResult {
  const sourceBytes = request.source.modules.reduce((total, module) => total + module.source.length, 0);
  let compileUsage = usage(sourceBytes);
  const reject = (code: string, message: string, start = 0, end = 0): RejectedCheck =>
    Object.freeze({
      status: 'rejected',
      diagnostics: Object.freeze([diagnostic(request, code, message, start, end)]),
      usage: compileUsage,
    });
  if (!sameVersion(request.abiVersion, ABI_VERSION) || !sameVersion(request.languageVersion, { major: 1, minor: 0 }))
    return Object.freeze({ status: 'bridge_error', error: bridgeError('check', 'unsupported_version') });
  const slot = validateRegistry(request.registry, request.slotId);
  if (typeof slot === 'string') return reject('SS_CONTRACT_INVALID', slot);
  if (!sameVersion(slot.languageVersion, request.languageVersion))
    return reject('SS_SLOT_LANGUAGE_MISMATCH', 'slot language version does not match request');
  if (!compileLimitsValid(request.limits, slot.compileLimits))
    return reject('SS_COMPILER_LIMIT', 'compile limits exceed the slot ceiling');
  if (request.source.modules.length !== 1 || request.source.modules.length > request.limits.modules)
    return reject('SS_MODULE_SET_INVALID', 'language 1.0 accepts one source module plus reserved generated modules');
  const module = request.source.modules[0];
  if (!module || module.id !== request.source.entry) return reject('SS_MODULE_SET_INVALID', 'entry module is absent');
  if (sourceBytes > request.limits.sourceBytes || module.source.length > request.limits.moduleBytes)
    return reject('SS_COMPILER_LIMIT', 'source byte limit exceeded');
  const text = decodeSource(module.source);
  if (text === undefined) return reject('SS_SOURCE_ENCODING', 'source must be canonical UTF-8');
  const compiled = compileProgram(text, module.id, request.registry, slot);
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
      language: request.languageVersion,
      ir: IR_VERSION,
      abi: ABI_VERSION,
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
  return (Object.keys(ceiling) as (keyof ExecutionLimits)[]).every(
    (key) => Number.isSafeInteger(limits[key]) && limits[key] >= 0 && limits[key] <= ceiling[key],
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
    abiVersion: ABI_VERSION,
    requestId,
    result: Object.freeze({ tag: 'failed', value: Object.freeze({ effectState, failure: Object.freeze({ code }) }) }),
  });
}

function matchingOutcome(value: unknown, requestId: ActionOutcome['requestId']): value is ActionOutcome {
  if (value === null || typeof value !== 'object') return false;
  const outcome = value as Partial<ActionOutcome>;
  if (
    !outcome.abiVersion ||
    !sameVersion(outcome.abiVersion, ABI_VERSION) ||
    outcome.requestId !== requestId ||
    !outcome.result
  )
    return false;
  if (outcome.result.tag === 'completed') return isByteArray(outcome.result.value);
  if (outcome.result.tag === 'rejected')
    return (
      typeof outcome.result.value?.code === 'string' &&
      (outcome.result.value.detail === undefined || typeof outcome.result.value.detail === 'string')
    );
  if (outcome.result.tag !== 'failed') return false;
  return (
    (outcome.result.value?.effectState === 'not_performed' || outcome.result.value?.effectState === 'unknown') &&
    [
      'cancelled',
      'timeout',
      'unavailable',
      'handler_fault',
      'invalid_result',
      'transport_lost',
      'gateway_fault',
    ].includes(outcome.result.value.failure?.code)
  );
}

function emptyUsage(): MutableUsage {
  return {
    fuel: 0,
    allocations: 0,
    allocatedBytes: 0,
    peakRetainedBytes: 0,
    hostCalls: 0,
    traceBytes: 0,
    outputBytes: 0,
  };
}

function valueLimits(limits: ExecutionLimits, maxBytes = limits.maxBytes): ValueLimits {
  return { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxBytes };
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
    block.terminator.tag === 'action' ? [block.terminator] : [],
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
    if (this.active.cancelled) throw new InterpreterFault('cancelled');
    const operation = this.artifact.program.operations.get(instruction.operationId);
    if (!operation) throw new ExecutionFault('invalid_ir', 'unknown operation');
    const input = this.encodeInput(instruction, value);
    this.assertHostCapacity();
    this.meter.charge(100 + operation.effectCost + Math.ceil(input.length / 16));
    this.usage.hostCalls++;
    const actionRequest = this.createRequest(instruction, operation, input);
    this.records.push(Object.freeze({ phase: 'requested', request: actionRequest }));
    return this.dispatch(actionRequest, operation);
  }

  private encodeInput(instruction: ActionInstruction, value: CanonicalValue): CanonicalBytes {
    const encoded = encodeCanonical(instruction.inputType, value, {
      registry: this.request.registry.schemas,
      limits: valueLimits(this.request.limits),
    });
    if (!encoded.ok) throw new ExecutionFault('value_limit', encoded.failure.code);
    return frozenBytes(encoded.value);
  }

  private assertHostCapacity(): void {
    if (this.usage.hostCalls + 1 > this.request.limits.hostCalls || this.request.limits.concurrentActions < 1)
      throw new ExecutionFault(
        'resource_exhausted',
        this.usage.hostCalls + 1 > this.request.limits.hostCalls ? 'hostCalls' : 'concurrentActions',
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
    if (key && !key.ok) throw new ExecutionFault('invalid_request', key.failure.code);
    this.sequence++;
    return Object.freeze({
      abiVersion: ABI_VERSION,
      contractId: this.request.registry.id,
      requiredContractVersion: this.request.registry.version,
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

  private async dispatch(actionRequest: ActionRequest, operation: OperationDefinition): Promise<CanonicalValue> {
    if (this.active.cancelled) return this.cancel(actionRequest.requestId, 'not_performed');
    this.active.dispatched = true;
    let received: unknown;
    try {
      received = await this.host.handleAction(actionRequest);
    } catch {
      received = failedOutcome(actionRequest.requestId, 'handler_fault', 'unknown');
    }
    if (this.active.cancelled) return this.cancel(actionRequest.requestId, 'unknown');
    return this.interpretOutcome(actionRequest.requestId, operation, received);
  }

  private cancel(requestId: ActionOutcome['requestId'], effectState: 'not_performed' | 'unknown'): never {
    const outcome = failedOutcome(requestId, 'cancelled', effectState);
    this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
    throw new InterpreterFault('cancelled');
  }

  private interpretOutcome(
    requestId: ActionOutcome['requestId'],
    operation: OperationDefinition,
    received: unknown,
  ): CanonicalValue {
    if (!matchingOutcome(received, requestId)) {
      const outcome = failedOutcome(requestId, 'gateway_fault', 'unknown');
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
      throw new ExecutionFault('action_outcome_invalid');
    }
    if (received.result.tag === 'failed') {
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
      throw new ExecutionFault(received.result.value.failure.code, received.result.value.effectState);
    }
    if (received.result.tag === 'rejected') return this.policyRejection(requestId, operation, received);
    return this.completed(requestId, operation, received);
  }

  private policyRejection(
    requestId: ActionOutcome['requestId'],
    operation: OperationDefinition,
    received: ActionOutcome,
  ): CanonicalValue {
    if (received.result.tag !== 'rejected') throw new ExecutionFault('invalid_ir', 'expected rejected outcome');
    const error = policyErrorValue(schemaRef(operation.error), this.request.registry.schemas, received.result.value);
    if (error === undefined) {
      const outcome = failedOutcome(requestId, 'invalid_result', 'not_performed');
      this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome }));
      throw new ExecutionFault('action_outcome_invalid', 'policy error does not match operation error schema');
    }
    this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
    return Object.freeze({ tag: 'error', value: error });
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
    this.records.push(Object.freeze({ phase: 'resolved', requestId, outcome: received }));
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
    const result = checkCompile(request);
    if (result.status !== 'accepted') return result;
    const program = result.compiled.artifact.program.program;
    const graph = frozenBytes(
      encoder.encode(
        JSON.stringify({
          version: [1, 0],
          handler: result.compiled.artifact.handler,
          trigger: request.slotId,
          predicates: program.blocks.flatMap((block) =>
            block.instructions
              .filter((instruction) => instruction.tag === 'compare')
              .map((instruction) => ({ operator: instruction.operator, source: instruction.source })),
          ),
          branches: program.blocks
            .filter((block) => block.terminator.tag === 'branch' || block.terminator.tag === 'switch')
            .map((block) => ({ block: block.id, kind: block.terminator.tag })),
          actions: actionInstructions(result.compiled.artifact).map((action) => ({
            operationId: action.operationId,
            effectId: action.effectId,
            capabilityId: action.capabilityId,
            actionSiteId: action.actionSiteId,
            source: action.source,
          })),
        }),
      ),
    );
    const check: AcceptedCheck = Object.freeze({
      status: result.status,
      artifact: result.artifact,
      summary: result.summary,
      provenance: result.provenance,
      usage: result.usage,
      diagnostics: result.diagnostics,
    });
    return Object.freeze({
      status: 'accepted',
      check,
      views: Object.freeze(request.views.includes('semantic_graph') ? { semantic_graph: graph } : {}),
    });
  }

  execute(request: Parameters<RuntimeBridge['execute']>[0], host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (this.closed) return Promise.resolve({ status: 'bridge_error', error: bridgeError('execute', 'bridge_closed') });
    // Invocation IDs are unique only while active; no durable tombstones or replay coordinator are retained.
    if (this.active.has(request.invocationId))
      return Promise.resolve({
        status: 'not_started',
        error: bridgeError('execute', 'invalid_request', 'duplicate active invocation'),
      });
    const active: ActiveInvocation = { cancelled: false, dispatched: false };
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
    if (!sameVersion(request.abiVersion, ABI_VERSION))
      return { status: 'bridge_error', error: bridgeError('execute', 'unsupported_version') };
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
          error: bridgeError('execute', 'invalid_request', 'artifact verification failed'),
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
    const trace = new ExecutionTrace(request.trace !== 'none', request.limits.traceBytes, usageValue);
    const dispatcher = new ActionDispatcher(request, host, active, artifact, records, meter, usageValue);
    try {
      trace.add('invocation_started', {
        module: artifact.program.program.blocks[0]?.terminator.source.module as SourceLocation['module'],
        start: 0,
        end: 0,
      });
      const value = await interpret(artifact.program, input.value, {
        charge: (fuel, allocation) => meter.charge(fuel, allocation),
        cancelled: () => active.cancelled,
        trace: (event, source) => trace.add(event, source),
        action: (instruction, actionValue) => dispatcher.handle(instruction, actionValue),
      });
      const output = encodeCanonical(schemaRef(slot.output), value, {
        registry: request.registry.schemas,
        limits: valueLimits(request.limits, Math.min(request.limits.maxBytes, request.limits.outputBytes)),
      });
      if (!output.ok) throw new ExecutionFault('invalid_output', output.failure.code);
      if (usageValue.outputBytes + output.value.length > request.limits.outputBytes)
        throw new ExecutionFault('resource_exhausted', 'outputBytes');
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
            error: { code: fault.code, ...(fault.detail === undefined ? {} : { detail: fault.detail }) },
            facts: terminalFacts,
          };
    }
  }

  async cancel(request: Parameters<RuntimeBridge['cancel']>[0]) {
    if (this.closed) return { status: 'bridge_error' as const, error: bridgeError('cancel', 'bridge_closed') };
    if (!sameVersion(request.abiVersion, ABI_VERSION))
      return { status: 'bridge_error' as const, error: bridgeError('cancel', 'unsupported_version') };
    const active = this.active.get(request.invocationId);
    if (!active) return { status: 'not_active' as const };
    active.cancelled = true;
    return { status: 'accepted' as const };
  }

  async close(): Promise<CloseResult> {
    if (this.closed) return { status: 'closed' };
    this.closed = true;
    // Close follows ordinary cancellation semantics so late host results cannot replay or resume an invocation.
    for (const active of this.active.values()) active.cancelled = true;
    await Promise.allSettled([...this.executions]);
    return { status: 'closed' };
  }
}
