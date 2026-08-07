import {
  type ActionRequest,
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
  type InspectResult,
  type InspectView,
  type InstantValue,
  type InvocationId,
  type ModuleId,
  type OperationId,
  type PolicyError,
  type Result,
  type RuntimeBridge,
  type Sha256Digest,
  type TraceMode,
} from '@safescript/contracts';
import type { EngineOptions } from '@safescript/engine';

import type { Contract, Operation, Operations, Slot, Slots } from './contract.js';

export class SdkConfigurationError extends TypeError {
  override readonly name = 'SdkConfigurationError';
}

export type SafeScriptOptions = EngineOptions;

export interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ActionContext<C> {
  readonly invocationId: InvocationId;
  readonly context: C;
  readonly request: ActionRequest;
  readonly resourceScope: Readonly<Record<string, string>>;
  readonly idempotencyKey?: Sha256Digest;
  readonly signal: AbortSignal;
}

export type AuthorisationDecision<E extends PolicyError = PolicyError> =
  Readonly<{ status: 'allowed' }> | Readonly<{ status: 'rejected'; error: E }>;
export type HandlerFailure = Readonly<{ status: 'failed'; effectState: EffectState; failure: HostFailure }>;
export type OperationHandler<I, O, E, C> = (
  input: I,
  context: ActionContext<C>,
) => Result<O, E> | HandlerFailure | Promise<Result<O, E> | HandlerFailure>;

export type HandlerTable<O extends Operations, C> = {
  readonly [K in keyof O]: O[K] extends Operation<infer I, infer Output, infer E>
    ? OperationHandler<I, Output, E, C>
    : never;
};
type SlotInput<S extends Slots, K extends keyof S> = S[K] extends Slot<infer I, unknown> ? I : never;
type SlotOutput<S extends Slots, K extends keyof S> = S[K] extends Slot<unknown, infer O> ? O : never;

export interface SourceProgram {
  readonly entryModule: ModuleId;
  readonly modules: readonly Readonly<{ id: ModuleId; source: string }>[];
}

export type Program =
  | Readonly<{ kind: 'source'; source: SourceProgram }>
  | Readonly<{ kind: 'artifact'; bytes: Uint8Array | CanonicalBytes }>;

export interface CheckRequest<K extends PropertyKey> {
  readonly slot: K;
  readonly source: SourceProgram;
  readonly limits?: Partial<CompileLimits>;
}
export interface InspectRequest<K extends PropertyKey> extends CheckRequest<K> {
  readonly views: readonly InspectView[];
}
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

export type SdkExecutionFacts = Extract<BridgeExecutionResult, { status: 'completed' }>['facts'] &
  Readonly<{ invocationId: InvocationId }>;
export type ExecutionResult<O> =
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
    }>;

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
  readonly resources?: Partial<
    Extract<BridgeExecutionResult, { status: 'completed' | 'failed' | 'cancelled' }>['facts']['usage']
  >;
}

export interface TestRequest<K extends PropertyKey, I, O, Ops extends Operations = Operations> {
  readonly name: string;
  readonly slot: K;
  readonly program: Program;
  readonly input: I;
  readonly actions?: readonly ScriptedAction<Ops>[];
  readonly fixed?: Readonly<{
    instant?: InstantValue;
    randomSeed?: Uint8Array | CanonicalBytes;
    invocationId?: InvocationId;
    idempotencySeed?: Uint8Array | CanonicalBytes;
  }>;
  readonly expect?: TestExpectation<O>;
}

export interface TestMismatch {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}
export interface TestReport<O> {
  readonly passed: boolean;
  readonly mismatches: readonly TestMismatch[];
  readonly execution: ExecutionResult<O>;
}

export interface CreateSafeScriptOptions<
  C,
  O extends Operations,
  S extends Slots,
  E extends PolicyError = PolicyError,
> {
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
  execute<K extends keyof S>(
    request: ExecuteRequest<K, SlotInput<S, K>, C>,
  ): Promise<ExecutionResult<SlotOutput<S, K>>>;
  test<K extends keyof S>(
    request: TestRequest<K, SlotInput<S, K>, SlotOutput<S, K>, O>,
  ): Promise<TestReport<SlotOutput<S, K>>>;
  cancel(invocationId: InvocationId): Promise<CancelResult>;
  close(): Promise<CloseResult>;
}
