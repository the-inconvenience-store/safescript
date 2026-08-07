import { randomBytes } from 'node:crypto';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type BridgeError,
  type CancelResult,
  type CanonicalBytes,
  type CapabilityDefinition,
  type CapabilityId,
  type CheckResult,
  type CloseResult,
  type CompileLimits,
  type ContractId,
  type ContractRegistry,
  type EffectDefinition,
  type EffectId,
  type EffectState,
  type ExecuteRequest as BridgeExecuteRequest,
  type ExecutionLimits,
  type ExecutionResult as BridgeExecutionResult,
  type HostFailure,
  type InspectResult,
  type InspectView,
  type InstantValue,
  type InvocationId,
  type ModuleId,
  type OperationDefinition,
  type OperationId,
  type PolicyError,
  type Result,
  type RuntimeBridge,
  type RuntimeBridgeHost,
  type Schema,
  type SemVer,
  type Sha256Digest,
  type SlotDefinition,
  type SlotId,
  type SourceProgram as BridgeSourceProgram,
  type TraceMode,
  type TypeDefinition,
  type TypeId,
  type Version,
} from '@safescript/contracts';
import { createDirectRuntimeBridge, type EngineOptions } from '@safescript/engine';

const ABI_VERSION: Version = Object.freeze({ major: 1, minor: 0 });
const encodeUtf8 = (value: string): Uint8Array => Buffer.from(value, 'utf8');

export class ContractDefinitionError extends TypeError {
  override readonly name = 'ContractDefinitionError';
}

export class SdkConfigurationError extends TypeError {
  override readonly name = 'SdkConfigurationError';
}

export type SafeScriptOptions = EngineOptions;

export interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ContractType<T> {
  readonly id: TypeId;
  readonly schema: Schema;
  readonly _type?: T;
}

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

type Operations = Readonly<Record<string, Omit<Operation<unknown, unknown, unknown>, 'resourceScope'> & Readonly<{ resourceScope: (input: never) => Readonly<Record<string, string>> }>>>;
type Slots = Readonly<Record<string, Slot<unknown, unknown>>>;

export interface ContractDefinition<O extends Operations, S extends Slots> {
  readonly id: ContractId;
  readonly version: SemVer;
  readonly types?: readonly ContractType<unknown>[];
  readonly operations: O;
  readonly slots: S;
}

export interface Codec<T> {
  encode(value: T): CanonicalBytes;
  decode(bytes: Uint8Array | CanonicalBytes): T;
}

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

function stable(value: unknown): string {
  if (typeof value === 'bigint') return `{"$bigint":"${value}"}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('unsupported contract value');
  return encoded;
}

function fingerprint(domain: 'type' | 'contract', value: unknown): Sha256Digest {
  return hash(domain, encodeUtf8(stable(value)));
}

function completeLimits<T extends object>(standard: T, ...overrides: readonly (Partial<T> | undefined)[]): T {
  const limits = { ...standard };
  const standardRecord = standard as Readonly<Record<string, number>>;
  for (const override of overrides) {
    if (!override) continue;
    for (const [name, value] of Object.entries(override)) {
      if (typeof value !== 'number' || !(name in standard) || !Number.isSafeInteger(value) || value < 0 || value > (standardRecord[name] as number)) throw new TypeError(`invalid ${name} limit`);
      (limits as Record<string, number>)[name] = value;
    }
  }
  return Object.freeze(limits);
}

function schemaTypeName(id: TypeId): string {
  return String(id).slice(5).split(/[.-]/).map((part) => part[0]?.toUpperCase() + part.slice(1)).join('');
}

function typeScriptType(schema: Schema): string {
  switch (schema.kind) {
    case 'unit': return 'null';
    case 'boolean': return 'boolean';
    case 'int64': return 'bigint';
    case 'float64': return 'number';
    case 'string': return 'string';
    case 'bytes': return 'readonly number[]';
    case 'instant': return 'Readonly<{ epochSeconds: bigint; nanoseconds: number }>';
    case 'list': return `readonly (${typeScriptType(schema.item)})[]`;
    case 'tuple': return `readonly [${schema.items.map(typeScriptType).join(', ')}]`;
    case 'record': return `Readonly<{ ${schema.fields.map((field) => `${field.name}: ${typeScriptType(field.schema)}`).join('; ')} }>`;
    case 'variant': return schema.variants.map((variant) => `Readonly<{ tag: ${JSON.stringify(variant.tag)}; value: ${typeScriptType(variant.schema)} }>`).join(' | ');
    case 'brand': return `${typeScriptType(schema.base)} & { readonly __brand: ${JSON.stringify(String(schema.type))} }`;
    case 'ref': return schemaTypeName(schema.type);
  }
}

function freeze<T>(root: T): T {
  const pending: object[] = root !== null && (typeof root === 'object' || typeof root === 'function') ? [root as object] : [];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop() as object;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  return root;
}

export function defineContract<const O extends Operations, const S extends Slots>(definition: ContractDefinition<O, S>): Contract<O, S> {
  try {
    ids.contract(definition.id);
    if (!Number.isSafeInteger(definition.version.major) || definition.version.major < 0 || !Number.isSafeInteger(definition.version.minor) || definition.version.minor < 0 || !Number.isSafeInteger(definition.version.patch) || definition.version.patch < 0 || (definition.version.prerelease !== undefined && !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(definition.version.prerelease))) throw new TypeError('invalid contract version');
    const referenced = [
      ...(definition.types ?? []),
      ...Object.values(definition.operations).flatMap((operation) => [operation.input, operation.output, operation.error]),
      ...Object.values(definition.slots).flatMap((slot) => [slot.input, slot.output]),
    ];
    const uniqueTypes = new Map<TypeId, ContractType<unknown>>();
    for (const type of referenced) {
      ids.type(type.id);
      const existing = uniqueTypes.get(type.id);
      if (existing && stable(existing.schema) !== stable(type.schema)) throw new TypeError(`conflicting schema ${type.id}`);
      uniqueTypes.set(type.id, type);
    }
    const typeDefinitions: TypeDefinition[] = [...uniqueTypes.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0).map((type) => ({
      id: type.id,
      schema: type.schema,
      fingerprint: fingerprint('type', type.schema),
    }));
    const schemas = defineSchemaRegistry(typeDefinitions);
    const effects = new Map<EffectId, EffectDefinition>();
    const capabilities = new Map<CapabilityId, CapabilityDefinition>();
    const operations: OperationDefinition[] = Object.values(definition.operations).map((operation) => {
      ids.operation(operation.id);
      ids.effect(operation.effect);
      ids.capability(operation.capability);
      if (!Number.isSafeInteger(operation.effectCost) || operation.effectCost < 0) throw new TypeError(`invalid effect cost for ${operation.id}`);
      if (operation.idempotency !== 'none' && operation.idempotency !== 'required') throw new TypeError(`invalid idempotency for ${operation.id}`);
      if (typeof operation.resourceScope !== 'function') throw new TypeError(`missing resource scope for ${operation.id}`);
      effects.set(operation.effect, { id: operation.effect, fingerprint: fingerprint('contract', operation.effect) });
      capabilities.set(operation.capability, { id: operation.capability, fingerprint: fingerprint('contract', operation.capability) });
      const record = { id: operation.id, input: operation.input.id, output: operation.output.id, error: operation.error.id, effect: operation.effect, capability: operation.capability, effectCost: operation.effectCost, idempotency: operation.idempotency };
      return { ...record, fingerprint: fingerprint('contract', record) };
    }).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length) throw new TypeError('duplicate operation id');
    const slots: SlotDefinition[] = Object.values(definition.slots).map((slot) => {
      ids.slot(slot.id);
      if (!Number.isSafeInteger(slot.languageVersion.major) || slot.languageVersion.major < 0 || !Number.isSafeInteger(slot.languageVersion.minor) || slot.languageVersion.minor < 0) throw new TypeError(`invalid language version for ${slot.id}`);
      for (const effect of slot.effects) {
        ids.effect(effect);
        if (!effects.has(effect)) throw new TypeError(`unknown effect ${effect}`);
      }
      for (const capability of slot.capabilities) {
        ids.capability(capability);
        if (!capabilities.has(capability)) throw new TypeError(`unknown capability ${capability}`);
      }
      if (new Set(slot.effects).size !== slot.effects.length || new Set(slot.capabilities).size !== slot.capabilities.length) throw new TypeError(`duplicate slot permission ${slot.id}`);
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
    }).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    if (new Set(slots.map((slot) => slot.id)).size !== slots.length) throw new TypeError('duplicate slot id');
    const sortedEffects = [...effects.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    const sortedCapabilities = [...capabilities.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    const definitions = [...typeDefinitions, ...sortedEffects, ...sortedCapabilities, ...operations, ...slots].map(({ id, fingerprint: value }) => ({ id, fingerprint: value }));
    const digest = fingerprint('contract', { id: definition.id, version: definition.version, definitions });
    const registry: ContractRegistry = freeze({ id: definition.id, version: definition.version, digest, schemas, effects: sortedEffects, capabilities: sortedCapabilities, operations, slots, definitions });
    const codecs = Object.fromEntries([...uniqueTypes.values()].map((type) => [type.id, freeze({
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
    })]));
    const declarations = typeDefinitions.map((type) => `export type ${schemaTypeName(type.id)} = ${typeScriptType(type.schema)};`).join('\n');
    return freeze({ id: definition.id, version: definition.version, registry, fingerprint: digest, declarations, codecs, operations: definition.operations, slots: definition.slots });
  } catch (error) {
    if (error instanceof ContractDefinitionError) throw error;
    throw new ContractDefinitionError(error instanceof Error ? error.message : 'invalid contract definition');
  }
}

export interface ActionContext<C> {
  readonly invocationId: InvocationId;
  readonly context: C;
  readonly request: ActionRequest;
  readonly resourceScope: Readonly<Record<string, string>>;
  readonly idempotencyKey?: Sha256Digest;
  readonly signal: AbortSignal;
}

export type AuthorisationDecision<E extends PolicyError = PolicyError> = Readonly<{ status: 'allowed' }> | Readonly<{ status: 'rejected'; error: E }>;
export type HandlerFailure = Readonly<{ status: 'failed'; effectState: EffectState; failure: HostFailure }>;
export type OperationHandler<I, O, E, C> = (input: I, context: ActionContext<C>) => Result<O, E> | HandlerFailure | Promise<Result<O, E> | HandlerFailure>;

type HandlerTable<O extends Operations, C> = { readonly [K in keyof O]: O[K] extends Operation<infer I, infer Output, infer E> ? OperationHandler<I, Output, E, C> : never };
type SlotInput<S extends Slots, K extends keyof S> = S[K] extends Slot<infer I, unknown> ? I : never;
type SlotOutput<S extends Slots, K extends keyof S> = S[K] extends Slot<unknown, infer O> ? O : never;

export interface SourceProgram {
  readonly entryModule: ModuleId;
  readonly modules: readonly Readonly<{ id: ModuleId; source: string }>[];
}

export type Program = Readonly<{ kind: 'source'; source: SourceProgram }> | Readonly<{ kind: 'artifact'; bytes: Uint8Array | CanonicalBytes }>;

export interface CheckRequest<K extends PropertyKey> { readonly slot: K; readonly source: SourceProgram; readonly limits?: Partial<CompileLimits> }
export interface InspectRequest<K extends PropertyKey> extends CheckRequest<K> { readonly views: readonly InspectView[] }
export interface ExecuteRequest<K extends PropertyKey, I, C> {
  readonly slot: K;
  readonly program: Program;
  readonly input: I;
  readonly context: C;
  readonly invocationId?: InvocationId;
  readonly idempotencySeed?: Uint8Array | CanonicalBytes;
  readonly fixedInstant?: InstantValue;
  readonly randomSeed?: Uint8Array | CanonicalBytes;
  readonly limits?: Partial<ExecutionLimits>;
  readonly trace?: TraceMode;
  readonly signal?: AbortSignal;
}

export type SdkExecutionFacts = Extract<BridgeExecutionResult, { status: 'completed' }>['facts'] & Readonly<{ invocationId: InvocationId }>;
export type ExecutionResult<O> =
  | Exclude<BridgeExecutionResult, { status: 'completed' | 'failed' | 'cancelled' }>
  | Readonly<{ status: 'completed'; output: O; facts: SdkExecutionFacts }>
  | Readonly<{ status: 'failed'; error: Extract<BridgeExecutionResult, { status: 'failed' }>['error']; facts: SdkExecutionFacts }>
  | Readonly<{ status: 'cancelled'; error: Extract<BridgeExecutionResult, { status: 'cancelled' }>['error']; facts: SdkExecutionFacts }>;

export interface ScriptedAction<O extends Operations = Operations> {
  readonly operation: keyof O | OperationId;
  readonly input: unknown;
  readonly authorisation?: AuthorisationDecision;
  readonly outcome: Result<unknown, unknown> | HandlerFailure;
}

export interface TestExpectation<O> {
  readonly status?: ExecutionResult<O>['status'];
  readonly output?: O;
  readonly effects?: readonly EffectId[];
  readonly actions?: readonly unknown[];
  readonly diagnostics?: readonly unknown[];
  readonly resources?: Partial<Extract<BridgeExecutionResult, { status: 'completed' | 'failed' | 'cancelled' }>['facts']['usage']>;
}

export interface TestRequest<K extends PropertyKey, I, O, Ops extends Operations = Operations> {
  readonly name: string;
  readonly slot: K;
  readonly program: Program;
  readonly input: I;
  readonly actions?: readonly ScriptedAction<Ops>[];
  readonly fixed?: Readonly<{ instant?: InstantValue; randomSeed?: Uint8Array | CanonicalBytes; invocationId?: InvocationId; idempotencySeed?: Uint8Array | CanonicalBytes }>;
  readonly expect?: TestExpectation<O>;
}

export interface TestMismatch { readonly path: string; readonly expected: unknown; readonly actual: unknown }
export interface TestReport<O> { readonly passed: boolean; readonly mismatches: readonly TestMismatch[]; readonly execution: ExecutionResult<O> }

export interface CreateSafeScriptOptions<C, O extends Operations, S extends Slots, E extends PolicyError = PolicyError> {
  readonly contract: Contract<O, S>;
  readonly handlers: HandlerTable<O, C>;
  readonly authorise: (context: ActionContext<C>) => AuthorisationDecision<E> | Promise<AuthorisationDecision<E>>;
  readonly bridge?: RuntimeBridge;
  readonly defaultCompileLimits?: Partial<CompileLimits>;
  readonly defaultExecutionLimits?: Partial<ExecutionLimits>;
  readonly createInvocationId?: () => InvocationId;
}

export interface SafeScript<O extends Operations, S extends Slots, C> {
  check<K extends keyof S>(request: CheckRequest<K>): Promise<CheckResult>;
  inspect<K extends keyof S>(request: InspectRequest<K>): Promise<InspectResult>;
  execute<K extends keyof S>(request: ExecuteRequest<K, SlotInput<S, K>, C>): Promise<ExecutionResult<SlotOutput<S, K>>>;
  test<K extends keyof S>(request: TestRequest<K, SlotInput<S, K>, SlotOutput<S, K>, O>): Promise<TestReport<SlotOutput<S, K>>>;
  cancel(invocationId: InvocationId): Promise<CancelResult>;
  close(): Promise<CloseResult>;
}

function bridgeError(phase: BridgeError['phase'], code: BridgeError['code'] = 'adapter_failure'): BridgeError {
  return Object.freeze({ code, phase });
}

function sourceProgram(source: SourceProgram): BridgeSourceProgram {
  return freeze({ entry: source.entryModule, modules: source.modules.map((module) => ({ id: module.id, source: [...encodeUtf8(module.source)] })) });
}

function mismatch(path: string, expected: unknown, actual: unknown): TestMismatch {
  return Object.freeze({ path, expected, actual });
}

export function createSafeScript<C, O extends Operations, S extends Slots, E extends PolicyError = PolicyError>(options: CreateSafeScriptOptions<C, O, S, E>): SafeScript<O, S, C> {
  const operationEntries = Object.entries(options.contract.operations);
  const handlerKeys = Object.keys(options.handlers);
  if (handlerKeys.length !== operationEntries.length || operationEntries.some(([key]) => typeof options.handlers[key] !== 'function') || handlerKeys.some((key) => !(key in options.contract.operations))) {
    throw new SdkConfigurationError('handlers must exactly match contract operations');
  }
  if (typeof options.authorise !== 'function') throw new SdkConfigurationError('authorise must be a function');
  const defaultCompileLimits = options.defaultCompileLimits;
  const defaultExecutionLimits = options.defaultExecutionLimits;
  try {
    completeLimits(STANDARD_COMPILE_LIMITS, defaultCompileLimits);
    completeLimits(STANDARD_EXECUTION_LIMITS, defaultExecutionLimits);
  } catch (error) {
    throw new SdkConfigurationError(error instanceof Error ? error.message : 'invalid SDK limits');
  }
  const bridge = options.bridge ?? createDirectRuntimeBridge();
  const createInvocationId = options.createInvocationId ?? (() => ids.invocation(`invocation:${randomBytes(16).toString('hex')}`));
  const operationsById = new Map(operationEntries.map(([key, operation]) => [operation.id, { key, operation }] as const));
  const slotsByKey = new Map(Object.entries(options.contract.slots));
  const controllers = new Map<InvocationId, AbortController>();
  let closing = false;
  let closePromise: Promise<CloseResult> | undefined;
  const active = new Set<Promise<unknown>>();

  const run = <T>(work: () => Promise<T>, closed: T): Promise<T> => {
    if (closing) return Promise.resolve(closed);
    let task: Promise<T>;
    try {
      task = Promise.resolve(work()).catch(() => closed);
    } catch {
      return Promise.resolve(closed);
    }
    active.add(task);
    void task.finally(() => active.delete(task));
    return task;
  };
  const slotFor = (key: PropertyKey): Slot<unknown, unknown> | undefined => slotsByKey.get(String(key));
  const compileLimits = (slot: Slot<unknown, unknown>, request?: Partial<CompileLimits>): CompileLimits => completeLimits(slot.compileLimits ? completeLimits(STANDARD_COMPILE_LIMITS, slot.compileLimits) : STANDARD_COMPILE_LIMITS, defaultCompileLimits, request);
  const executionLimits = (slot: Slot<unknown, unknown>, request?: Partial<ExecutionLimits>): ExecutionLimits => completeLimits(slot.executionLimits ? completeLimits(STANDARD_EXECUTION_LIMITS, slot.executionLimits) : STANDARD_EXECUTION_LIMITS, defaultExecutionLimits, request);
  const checkRequest = (slot: Slot<unknown, unknown>, source: SourceProgram, limits?: Partial<CompileLimits>) => freeze({ abiVersion: ABI_VERSION, languageVersion: slot.languageVersion, registry: options.contract.registry, slotId: slot.id, source: sourceProgram(source), limits: compileLimits(slot, limits) });
  const decodeOutput = (slot: Slot<unknown, unknown>, result: BridgeExecutionResult, invocationId: InvocationId): ExecutionResult<unknown> => {
    if (result.status === 'failed' || result.status === 'cancelled') return freeze({ ...result, facts: { ...result.facts, invocationId } });
    if (result.status !== 'completed') return result;
    const decoded = decodeCanonical({ kind: 'ref', type: slot.output.id }, Uint8Array.from(result.output), { registry: options.contract.registry.schemas });
    return decoded.ok ? freeze({ status: 'completed', output: decoded.value, facts: { ...result.facts, invocationId } }) : freeze({ status: 'bridge_error', error: bridgeError('execute') });
  };
  const requestFor = (slot: Slot<unknown, unknown>, request: ExecuteRequest<PropertyKey, unknown, C>, invocationId: InvocationId): BridgeExecuteRequest | BridgeError => {
    const input = encodeCanonical({ kind: 'ref', type: slot.input.id }, request.input, { registry: options.contract.registry.schemas });
    if (!input.ok) return bridgeError('execute', 'invalid_request');
    try {
      return freeze({
        abiVersion: ABI_VERSION,
        registry: options.contract.registry,
        slotId: slot.id,
        invocationId,
        program: request.program.kind === 'source' ? { kind: 'source', source: checkRequest(slot, request.program.source) } : { kind: 'artifact', bytes: [...request.program.bytes] },
        input: [...input.value],
        limits: executionLimits(slot, request.limits),
        ...(request.idempotencySeed === undefined ? {} : { idempotencySeed: [...request.idempotencySeed] }),
        ...(request.fixedInstant === undefined ? {} : { fixedInstant: request.fixedInstant }),
        ...(request.randomSeed === undefined ? {} : { randomSeed: [...request.randomSeed] }),
        trace: request.trace ?? 'none',
      });
    } catch {
      return bridgeError('execute', 'invalid_request');
    }
  };
  const executeBridge = async (slot: Slot<unknown, unknown>, request: ExecuteRequest<PropertyKey, unknown, C>, host: RuntimeBridgeHost, invocationId: InvocationId): Promise<ExecutionResult<unknown>> => {
    const assembled = requestFor(slot, request, invocationId);
    if ('code' in assembled) return freeze({ status: 'bridge_error', error: assembled });
    let removeAbort = (): void => undefined;
    try {
      const execution = bridge.execute(assembled, host);
      if (request.signal) {
        const cancel = (): void => { void bridge.cancel({ abiVersion: ABI_VERSION, invocationId }).catch(() => undefined); };
        if (request.signal.aborted) cancel();
        else {
          request.signal.addEventListener('abort', cancel, { once: true });
          removeAbort = () => request.signal?.removeEventListener('abort', cancel);
        }
      }
      return decodeOutput(slot, await execution, invocationId);
    } catch {
      return freeze({ status: 'bridge_error', error: bridgeError('execute') });
    } finally {
      removeAbort();
    }
  };
  const gateway = (context: C, slot: Slot<unknown, unknown>, signal: AbortSignal): RuntimeBridgeHost => {
    const handled = new Set<string>();
    return ({
    async handleAction(request: ActionRequest): Promise<ActionOutcome> {
      const entry = operationsById.get(request.operationId);
      const fail = (effectState: EffectState, code: HostFailure['code']): ActionOutcome => freeze({ abiVersion: ABI_VERSION, requestId: request.requestId, result: { tag: 'failed', value: { effectState, failure: { code } } } });
      if (!entry || request.abiVersion.major !== ABI_VERSION.major || request.abiVersion.minor > ABI_VERSION.minor || request.contractId !== options.contract.id || stable(request.requiredContractVersion) !== stable(options.contract.version) || request.slotId !== slot.id || request.effectId !== entry.operation.effect || request.capabilityId !== entry.operation.capability || !slot.effects.includes(request.effectId) || !slot.capabilities.includes(request.capabilityId) || (entry.operation.idempotency === 'required') !== (request.idempotencyKey !== undefined) || handled.has(request.requestId)) return fail('not_performed', 'gateway_fault');
      handled.add(request.requestId);
      const decoded = decodeCanonical({ kind: 'ref', type: entry.operation.input.id }, Uint8Array.from(request.input), { registry: options.contract.registry.schemas });
      if (!decoded.ok) return fail('not_performed', 'gateway_fault');
      let scope: Readonly<Record<string, string>>;
      try {
        const resourceScope = entry.operation.resourceScope as unknown as (input: unknown) => Readonly<Record<string, string>>;
        scope = freeze({ ...resourceScope(decoded.value) });
        if (Object.values(scope).some((value) => typeof value !== 'string')) return fail('not_performed', 'gateway_fault');
      } catch {
        return fail('not_performed', 'gateway_fault');
      }
      const actionContext: ActionContext<C> = freeze({ invocationId: request.invocationId, context, request, resourceScope: scope, ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }), signal });
      let decision: AuthorisationDecision<E>;
      try {
        decision = await options.authorise(actionContext);
      } catch {
        return fail('not_performed', 'gateway_fault');
      }
      if (decision.status === 'rejected') return typeof decision.error?.code === 'string' ? freeze({ abiVersion: ABI_VERSION, requestId: request.requestId, result: { tag: 'rejected', value: decision.error } }) : fail('not_performed', 'gateway_fault');
      if (decision.status !== 'allowed') return fail('not_performed', 'gateway_fault');
      try {
        const outcome = await options.handlers[entry.key]?.(decoded.value as never, actionContext);
        if (outcome && 'status' in outcome && outcome.status === 'failed') return (outcome.effectState === 'not_performed' || outcome.effectState === 'unknown') && typeof outcome.failure?.code === 'string' ? freeze({ abiVersion: ABI_VERSION, requestId: request.requestId, result: { tag: 'failed', value: { effectState: outcome.effectState, failure: outcome.failure } } }) : fail('unknown', 'invalid_result');
        const encoded = encodeCanonical(resultSchema({ kind: 'ref', type: entry.operation.output.id }, { kind: 'ref', type: entry.operation.error.id }), outcome, { registry: options.contract.registry.schemas });
        return encoded.ok ? freeze({ abiVersion: ABI_VERSION, requestId: request.requestId, result: { tag: 'completed', value: [...encoded.value] } }) : fail('unknown', 'invalid_result');
      } catch {
        return fail('unknown', 'handler_fault');
      }
    },
  });
  };

  return freeze({
    check(request: CheckRequest<PropertyKey>): Promise<CheckResult> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('check', 'bridge_closed') }) as CheckResult;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('check', 'invalid_request') });
        try { return await bridge.check(checkRequest(slot, request.source, request.limits)); } catch { return freeze({ status: 'bridge_error', error: bridgeError('check') }); }
      }, closed);
    },
    inspect(request: InspectRequest<PropertyKey>): Promise<InspectResult> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('inspect', 'bridge_closed') }) as InspectResult;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('inspect', 'invalid_request') });
        try { return await bridge.inspect({ ...checkRequest(slot, request.source, request.limits), views: request.views }); } catch { return freeze({ status: 'bridge_error', error: bridgeError('inspect') }); }
      }, closed);
    },
    execute(request: ExecuteRequest<PropertyKey, unknown, C>): Promise<ExecutionResult<unknown>> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('execute', 'bridge_closed') }) as ExecutionResult<unknown>;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') });
        let invocationId: InvocationId;
        try { invocationId = request.invocationId ?? createInvocationId(); ids.invocation(invocationId); } catch { return freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') }); }
        const controller = new AbortController();
        controllers.set(invocationId, controller);
        const abort = (): void => controller.abort();
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) controller.abort();
        try { return await executeBridge(slot, request, gateway(request.context, slot, controller.signal), invocationId); }
        finally { request.signal?.removeEventListener('abort', abort); controllers.delete(invocationId); }
      }, closed);
    },
    test(request: TestRequest<PropertyKey, unknown, unknown, O>): Promise<TestReport<unknown>> {
      const closedExecution = freeze({ status: 'bridge_error', error: bridgeError('execute', 'bridge_closed') }) as ExecutionResult<unknown>;
      return run(async () => {
        const slot = slotFor(request.slot);
        if (!slot) return freeze({ passed: false, mismatches: [mismatch('slot', request.slot, undefined)], execution: freeze({ status: 'bridge_error', error: bridgeError('execute', 'invalid_request') }) });
        const identity = hash('program', encodeUtf8(`${request.name}\0${stable(request.program)}`));
        const invocationId = request.fixed?.invocationId ?? ids.invocation(`invocation:${identity.slice(0, 32)}`);
        const scripts = request.actions ?? [];
        const mismatches: TestMismatch[] = [];
        const seenRequests = new Set<string>();
        let index = 0;
        const host: RuntimeBridgeHost = {
          async handleAction(action: ActionRequest): Promise<ActionOutcome> {
            const script = scripts[index++];
            const fail = (): ActionOutcome => freeze({ abiVersion: ABI_VERSION, requestId: action.requestId, result: { tag: 'failed', value: { effectState: 'not_performed', failure: { code: 'gateway_fault' } } } });
            if (seenRequests.has(action.requestId)) { mismatches.push(mismatch(`actions[${index - 1}].requestId`, 'unique request', action.requestId)); return fail(); }
            seenRequests.add(action.requestId);
            if (!script) { mismatches.push(mismatch(`actions[${index - 1}]`, 'scripted action', undefined)); return fail(); }
            const entry = typeof script.operation === 'string' && script.operation in options.contract.operations ? options.contract.operations[script.operation] : operationsById.get(script.operation as OperationId)?.operation;
            if (!entry || entry.id !== action.operationId) { mismatches.push(mismatch(`actions[${index - 1}].operation`, script.operation, action.operationId)); return fail(); }
            const expected = encodeCanonical({ kind: 'ref', type: entry.input.id }, script.input, { registry: options.contract.registry.schemas });
            if (!expected.ok || expected.value.length !== action.input.length || !expected.value.every((byte, byteIndex) => byte === action.input[byteIndex])) { mismatches.push(mismatch(`actions[${index - 1}].input`, script.input, action.input)); return fail(); }
            if (script.authorisation?.status === 'rejected') return freeze({ abiVersion: ABI_VERSION, requestId: action.requestId, result: { tag: 'rejected', value: script.authorisation.error } });
            if ('status' in script.outcome && script.outcome.status === 'failed') return freeze({ abiVersion: ABI_VERSION, requestId: action.requestId, result: { tag: 'failed', value: { effectState: script.outcome.effectState, failure: script.outcome.failure } } });
            const encoded = encodeCanonical(resultSchema({ kind: 'ref', type: entry.output.id }, { kind: 'ref', type: entry.error.id }), script.outcome, { registry: options.contract.registry.schemas });
            return encoded.ok ? freeze({ abiVersion: ABI_VERSION, requestId: action.requestId, result: { tag: 'completed', value: [...encoded.value] } }) : fail();
          },
        };
        const execution = await executeBridge(slot, {
          slot: request.slot,
          program: request.program,
          input: request.input,
          context: undefined as C,
          invocationId,
          idempotencySeed: request.fixed?.idempotencySeed ?? [...encodeUtf8(identity)],
          ...(request.fixed?.instant === undefined ? {} : { fixedInstant: request.fixed.instant }),
          randomSeed: request.fixed?.randomSeed ?? [...encodeUtf8(hash('program', encodeUtf8(`${identity}:random`)))],
        }, host, invocationId);
        if (index < scripts.length) mismatches.push(mismatch('actions.length', scripts.length, index));
        const expected = request.expect;
        if (expected?.status !== undefined && expected.status !== execution.status) mismatches.push(mismatch('status', expected.status, execution.status));
        if (expected?.output !== undefined && (execution.status !== 'completed' || stable(expected.output) !== stable(execution.output))) mismatches.push(mismatch('output', expected.output, execution.status === 'completed' ? execution.output : undefined));
        if (expected?.effects !== undefined) {
          const actual = execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled' ? execution.facts.actions.filter((record) => record.phase === 'requested').map((record) => record.request.effectId) : [];
          if (stable(expected.effects) !== stable(actual)) mismatches.push(mismatch('effects', expected.effects, actual));
        }
        if (expected?.actions !== undefined) {
          const actual = execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled' ? execution.facts.actions : [];
          if (stable(expected.actions) !== stable(actual)) mismatches.push(mismatch('actions', expected.actions, actual));
        }
        if (expected?.diagnostics !== undefined) {
          const actual = execution.status === 'not_started' ? execution.diagnostics ?? [] : [];
          if (stable(expected.diagnostics) !== stable(actual)) mismatches.push(mismatch('diagnostics', expected.diagnostics, actual));
        }
        if (expected?.resources !== undefined) {
          const actual = execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled' ? execution.facts.usage : undefined;
          for (const [key, value] of Object.entries(expected.resources)) if (actual?.[key as keyof typeof actual] !== value) mismatches.push(mismatch(`resources.${key}`, value, actual?.[key as keyof typeof actual]));
        }
        return freeze({ passed: mismatches.length === 0, mismatches, execution });
      }, freeze({ passed: false, mismatches: [mismatch('facade', 'open', 'closed')], execution: closedExecution }));
    },
    cancel(invocationId: InvocationId): Promise<CancelResult> {
      const closed = freeze({ status: 'bridge_error', error: bridgeError('cancel', 'bridge_closed') }) as CancelResult;
      return run(async () => { controllers.get(invocationId)?.abort(); try { return await bridge.cancel({ abiVersion: ABI_VERSION, invocationId }); } catch { return freeze({ status: 'bridge_error', error: bridgeError('cancel') }); } }, closed);
    },
    close(): Promise<CloseResult> {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      closePromise = (async () => {
        let result: CloseResult;
        try { result = await bridge.close(); } catch { result = freeze({ status: 'bridge_error', error: bridgeError('close') }); }
        await Promise.allSettled([...active]);
        return result;
      })();
      return closePromise;
    },
  }) as SafeScript<O, S, C>;
}

export type { CompileLimits, ExecutionLimits, InstantValue, InvocationId, ModuleId, PolicyError, Result, RuntimeBridge, Schema, SemVer, TraceMode } from '@safescript/contracts';
