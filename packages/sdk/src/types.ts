/**
 * Public SDK requests, results, handlers, and deterministic-test interfaces.
 * @packageDocumentation
 */
import {
  type ActionRequest,
  type ActionOutcome,
  type CancelResult,
  type CanonicalBytes,
  type CheckResult,
  type CloseResult,
  type CompileLimits,
  type EffectId,
  type EffectState,
  type ExecutionLimits,
  type ExecutionResult as BridgeExecutionResult,
  type HostFailure,
  type HookDiagnostic,
  type InspectResult,
  type InspectView,
  type InstantValue,
  type InvocationId,
  type ModuleId,
  type OperationId,
  type Result,
  type RuntimeBridge,
  type SemanticGraphLimits,
  type Sha256Digest,
  type SlotId,
  type TraceMode,
} from '@safescript/contracts';
import type { EngineOptions } from '@safescript/engine';

import type { Contract, Operation, Operations, Slot, Slots } from './contract.js';

/** Synchronous host-startup error raised by {@link createSafeScript}. */
export class SdkConfigurationError extends TypeError {
  override readonly name = 'SdkConfigurationError';
}

/** Low-level engine options retained for CLI and embedding configuration. */
export type SafeScriptOptions = EngineOptions;

/** Structural subset of the platform `AbortSignal` required by the SDK. */
export interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Validated invocation and request facts supplied to one operation handler. */
export interface ActionContext<C> {
  readonly invocationId: InvocationId;
  readonly context: C;
  readonly request: ActionRequest;
  readonly idempotencyKey?: Sha256Digest;
  readonly signal: AbortSignal;
}

/** Explicit infrastructure failure returned by a trusted operation handler. */
export type HandlerFailure = Readonly<{ status: 'failed'; effectState: EffectState; failure: HostFailure }>;
/** Typed implementation of one registered host operation. */
export type OperationHandler<I, O, E, C> = (
  input: I,
  context: ActionContext<C>,
) => Result<O, E> | HandlerFailure | Promise<Result<O, E> | HandlerFailure>;

/** Requires exactly one correctly typed handler for every contract operation. */
export type HandlerTable<O extends Operations, C> = {
  readonly [K in keyof O]: O[K] extends Operation<infer I, infer Output, infer E>
    ? OperationHandler<I, Output, E, C>
    : never;
};
type SlotInput<S extends Slots, K extends keyof S> = S[K] extends Slot<infer I, unknown> ? I : never;
type SlotOutput<S extends Slots, K extends keyof S> = S[K] extends Slot<unknown, infer O> ? O : never;
type OperationInput<O extends Operations, K extends keyof O> =
  O[K] extends Operation<infer I, unknown, unknown> ? I : never;
type OperationError<O extends Operations, K extends keyof O> =
  O[K] extends Operation<unknown, unknown, infer E> ? E : never;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

/** Complete TypeScript source module set accepted by the host-facing SDK. */
export interface SourceProgram {
  readonly entryModule: ModuleId;
  readonly modules: readonly Readonly<{ id: ModuleId; source: string }>[];
}

/** Source fast path or checked-artifact execution input. Both use the same runtime and gateway semantics. */
export type Program =
  | Readonly<{ kind: 'source'; source: SourceProgram }>
  | Readonly<{ kind: 'artifact'; bytes: Uint8Array | CanonicalBytes }>;

/** Host-facing source-check request for one named contract slot. */
export interface CheckRequest<K extends PropertyKey> {
  readonly slot: K;
  readonly source: SourceProgram;
  readonly limits?: Partial<CompileLimits>;
}
/** Source check plus explicitly requested read-only derived views. */
export interface InspectRequest<K extends PropertyKey> extends CheckRequest<K> {
  readonly views: readonly InspectView[];
  readonly graphLimits?: SemanticGraphLimits;
}
/** Typed execution request including host-local context and deterministic invocation inputs. */
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

/** Deliberate host decision returned before an otherwise valid execution starts. */
export type BeforeExecuteDecision =
  Readonly<{ status: 'continue' }> | Readonly<{ status: 'rejected'; code: string; detail?: string }>;

/** Deliberate host decision returned before one validated action dispatch. */
export type BeforeActionDecision<E> = Readonly<{ status: 'continue' }> | Readonly<{ status: 'stop'; error: E }>;

/** Immutable validated action facts supplied to host-local lifecycle hooks. */
export interface ActionHookContext<K extends PropertyKey, I, C> extends ActionContext<C> {
  readonly operation: K;
  readonly operationId: OperationId;
  readonly input: I;
}

/** Immutable validated execution facts supplied to host-local lifecycle hooks. */
export interface ExecutionHookContext<K extends PropertyKey, I, C> {
  readonly slot: K;
  readonly slotId: SlotId;
  readonly invocationId: InvocationId;
  readonly program: Program;
  readonly input: I;
  readonly context: C;
  readonly limits: ExecutionLimits;
  readonly trace: TraceMode;
  readonly signal: AbortSignal;
  readonly idempotencySeed?: CanonicalBytes;
  readonly fixedInstant?: InstantValue;
  readonly randomSeed?: CanonicalBytes;
}

type ExecutionHookContexts<C, S extends Slots> = {
  readonly [K in keyof S]: ExecutionHookContext<K, SlotInput<S, K>, C>;
}[keyof S];

type AfterExecuteEvents<C, S extends Slots> = {
  readonly [K in keyof S]: ExecutionHookContext<K, SlotInput<S, K>, C> &
    Readonly<{ result: ExecutionResult<SlotOutput<S, K>> }>;
}[keyof S];

type BeforeActionHook<C, O extends Operations> = UnionToIntersection<
  {
    readonly [K in keyof O]: (
      context: ActionHookContext<K, OperationInput<O, K>, C>,
    ) => BeforeActionDecision<OperationError<O, K>> | Promise<BeforeActionDecision<OperationError<O, K>>>;
  }[keyof O]
>;

type AfterActionEvents<C, O extends Operations> = {
  readonly [K in keyof O]: ActionHookContext<K, OperationInput<O, K>, C> & Readonly<{ outcome: ActionOutcome }>;
}[keyof O];

/** Optional host-local execution lifecycle hooks. */
export interface SafeScriptHooks<C, O extends Operations, S extends Slots> {
  readonly beforeExecute?: (
    context: ExecutionHookContexts<C, S>,
  ) => BeforeExecuteDecision | Promise<BeforeExecuteDecision>;
  readonly afterExecute?: (event: AfterExecuteEvents<C, S>) => unknown | Promise<unknown>;
  readonly beforeAction?: BeforeActionHook<C, O>;
  readonly afterAction?: (event: AfterActionEvents<C, O>) => unknown | Promise<unknown>;
}

/** Runtime facts augmented with the invocation identity chosen or generated by the SDK. */
export type SdkExecutionFacts = Extract<BridgeExecutionResult, { status: 'completed' }>['facts'] &
  Readonly<{ invocationId: InvocationId }>;
/** Bridge execution result with canonical output decoded to the selected slot's TypeScript type. */
export type ExecutionResult<O> = (
  | Exclude<BridgeExecutionResult, { status: 'completed' | 'failed' | 'cancelled' }>
  | Readonly<{ status: 'completed'; output: O; facts: SdkExecutionFacts }>
  | Readonly<{
      status: 'failed';
      error: Extract<BridgeExecutionResult, { status: 'failed' }>['error'];
      facts: SdkExecutionFacts;
    }>
  | Readonly<{
      status: 'cancelled';
      error: Extract<BridgeExecutionResult, { status: 'cancelled' }>['error'];
      facts: SdkExecutionFacts;
    }>
) &
  Readonly<{ hookDiagnostics?: readonly HookDiagnostic[] }>;

/** Expected ordered action and typed outcome used by the deterministic test host. */
export interface ScriptedAction<O extends Operations = Operations> {
  readonly operation: keyof O | OperationId;
  readonly input: unknown;
  readonly outcome: Result<unknown, unknown> | HandlerFailure;
}

/** Optional deterministic stand-in for a host rejecting execution before the runtime bridge starts. */
export type ScriptedExecutionRejection = Readonly<{
  status: 'rejected';
  code: string;
  detail?: string;
}>;

/** Optional observable facts asserted by {@link SafeScript.test}. */
export interface TestExpectation<O> {
  readonly status?: ExecutionResult<O>['status'];
  readonly output?: O;
  readonly effects?: readonly EffectId[];
  readonly actions?: readonly unknown[];
  readonly diagnostics?: readonly unknown[];
  readonly resources?: Partial<
    Extract<BridgeExecutionResult, { status: 'completed' | 'failed' | 'cancelled' }>['facts']['usage']
  >;
}

/** Deterministic test case executed through the same runtime bridge as production. */
export interface TestRequest<K extends PropertyKey, I, O, Ops extends Operations = Operations> {
  readonly name: string;
  readonly slot: K;
  readonly program: Program;
  readonly input: I;
  readonly execution?: ScriptedExecutionRejection;
  readonly actions?: readonly ScriptedAction<Ops>[];
  readonly fixed?: Readonly<{
    instant?: InstantValue;
    randomSeed?: Uint8Array | CanonicalBytes;
    invocationId?: InvocationId;
    idempotencySeed?: Uint8Array | CanonicalBytes;
  }>;
  readonly expect?: TestExpectation<O>;
}

/** Stable path-addressed difference between expected and observed test facts. */
export interface TestMismatch {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}
/** Complete non-throwing deterministic test result. */
export interface TestReport<O> {
  readonly passed: boolean;
  readonly mismatches: readonly TestMismatch[];
  readonly execution: ExecutionResult<O>;
}

/** Dependencies and defaults bound to one {@link SafeScript} facade. */
export interface CreateSafeScriptOptions<C, O extends Operations, S extends Slots> {
  readonly contract: Contract<O, S>;
  readonly handlers: HandlerTable<O, C>;
  readonly bridge?: RuntimeBridge;
  readonly defaultCompileLimits?: Partial<CompileLimits>;
  readonly defaultExecutionLimits?: Partial<ExecutionLimits>;
  readonly createInvocationId?: () => InvocationId;
  readonly hooks?: SafeScriptHooks<C, O, S>;
}

/**
 * Deep six-method host interface for source checking, inspection, execution, deterministic tests, cancellation, and
 * lifecycle.
 *
 * @remarks Calls made after `close()` resolve with stable `bridge_closed` results. `close()` is idempotent and waits
 * for active facade calls.
 */
export interface SafeScript<O extends Operations, S extends Slots, C> {
  check<K extends keyof S>(request: CheckRequest<K>): Promise<CheckResult>;
  inspect<K extends keyof S>(request: InspectRequest<K>): Promise<InspectResult>;
  execute<K extends keyof S>(
    request: ExecuteRequest<K, SlotInput<S, K>, C>,
  ): Promise<ExecutionResult<SlotOutput<S, K>>>;
  test<K extends keyof S>(
    request: TestRequest<K, SlotInput<S, K>, SlotOutput<S, K>, O>,
  ): Promise<TestReport<SlotOutput<S, K>>>;
  cancel(invocationId: InvocationId): Promise<CancelResult>;
  close(): Promise<CloseResult>;
}
