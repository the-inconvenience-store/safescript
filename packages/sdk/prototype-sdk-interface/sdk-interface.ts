// PROTOTYPE — exact candidate host-facing shape, not production declarations.
// Question: can one facade cover integration, execution, and deterministic tests
// without exposing runtime-bridge records or private engine concepts?

export type Brand<T, Name extends string> = T & { readonly __brand: Name }
export type ContractId = Brand<string, "ContractId">
export type ModuleId = Brand<string, "ModuleId">
export type OperationId = Brand<string, "OperationId">
export type SlotId = Brand<string, "SlotId">
export type InvocationId = Brand<string, "InvocationId">
export type TypeId = Brand<string, "TypeId">
export type Instant = Brand<string, "Temporal.Instant">

export interface Schema<T> {
  readonly typeId: TypeId
  readonly _type?: T
}

export type Result<T, E> =
  | { readonly tag: "ok"; readonly value: T }
  | { readonly tag: "error"; readonly value: E }

export interface Operation<I, O, E> {
  readonly id: OperationId
  readonly input: Schema<I>
  readonly output: Schema<O>
  readonly errors: Schema<E>
  readonly effectId: string
  readonly capabilityId: string
  readonly effectCost: number
  readonly idempotency: "none" | "optional" | "required"
  readonly resourceScope: (input: I) => Readonly<Record<string, string>>
}

export interface Slot<I, O> {
  readonly id: SlotId
  readonly input: Schema<I>
  readonly output: Schema<O>
  readonly language: "1.0.0" | "1.1.0"
  readonly effects: readonly string[]
  readonly capabilities: readonly string[]
  readonly limits?: Partial<Limits>
}

type Operations = Readonly<Record<string, Operation<unknown, unknown, unknown>>>
type Slots = Readonly<Record<string, Slot<unknown, unknown>>>

export interface ContractDefinition<O extends Operations, S extends Slots> {
  readonly id: ContractId
  readonly version: string
  readonly operations: O
  readonly slots: S
}

export interface Contract<O extends Operations, S extends Slots> {
  readonly id: ContractId
  readonly version: string
  readonly registryDigest: string
  readonly declarations: string
  readonly operations: O
  readonly slots: S
}

export declare function defineContract<const O extends Operations, const S extends Slots>(
  definition: ContractDefinition<O, S>,
): Contract<O, S>

export interface InvocationContext {
  readonly actorId: string
  readonly tenantId: string
  readonly attributes?: Readonly<Record<string, string>>
}

export type AuthorisationDecision<PolicyError> =
  | { readonly status: "allowed" }
  | { readonly status: "rejected"; readonly error: PolicyError }

export interface ActionContext<C> {
  readonly invocationId: InvocationId
  readonly context: C
  readonly operationId: OperationId
  readonly resourceScope: Readonly<Record<string, string>>
  readonly idempotencyKey?: string
  readonly signal: AbortSignal
}

export type HostFailure =
  | { readonly status: "failed"; readonly effectState: "not_performed"; readonly code: string }
  | { readonly status: "failed"; readonly effectState: "unknown"; readonly code: string }

export type OperationHandler<I, O, E, C> = (
  input: I,
  context: ActionContext<C>,
) => Promise<Result<O, E> | HostFailure>

export interface RuntimeBridge {
  check(request: unknown): Promise<unknown>
  inspect(request: unknown): Promise<unknown>
  execute(request: unknown, host: unknown): Promise<unknown>
  cancel(request: unknown): Promise<unknown>
  close(): Promise<unknown>
}

export interface CreateSafeScriptOptions<C, O extends Operations, S extends Slots, PolicyError> {
  readonly contract: Contract<O, S>
  readonly handlers: Readonly<Record<keyof O, OperationHandler<never, never, never, C>>>
  readonly authorise: (
    context: ActionContext<C>,
  ) => AuthorisationDecision<PolicyError> | Promise<AuthorisationDecision<PolicyError>>
  readonly bridge?: RuntimeBridge
  readonly defaultLimits?: Partial<Limits>
  readonly createInvocationId?: () => InvocationId
}

export interface SourceProgram {
  readonly entryModule: ModuleId
  readonly modules: readonly {
    readonly id: ModuleId
    readonly source: string
  }[]
}

export type Program =
  | { readonly kind: "source"; readonly source: SourceProgram }
  | { readonly kind: "artifact"; readonly bytes: Uint8Array }

export interface Limits {
  readonly fuel: number
  readonly allocations: number
  readonly allocatedBytes: number
  readonly retainedBytes: number
  readonly collectionItems: number
  readonly valueDepth: number
  readonly valueNodes: number
  readonly valueBytes: number
  readonly stackDepth: number
  readonly hostCalls: number
  readonly concurrentActions: number
  readonly traceBytes: number
  readonly outputBytes: number
}

export type TraceMode = "none" | "summary" | "semantic"
export type View = "semanticGraph"

export interface CheckRequest<K extends PropertyKey> {
  readonly slot: K
  readonly source: SourceProgram
  readonly limits?: Partial<Limits>
}

export interface InspectRequest<K extends PropertyKey> extends CheckRequest<K> {
  readonly views: readonly View[]
}

export interface ExecuteRequest<K extends PropertyKey, I, C> {
  readonly slot: K
  readonly program: Program
  readonly input: I
  readonly context: C
  readonly invocationId?: InvocationId
  readonly idempotencySeed?: Uint8Array
  readonly instant?: Instant
  readonly randomSeed?: Uint8Array
  readonly limits?: Partial<Limits>
  readonly trace?: TraceMode
  readonly signal?: AbortSignal
}

export type CheckResult =
  | { readonly status: "accepted"; readonly artifact: Uint8Array; readonly summary: unknown; readonly diagnostics: readonly unknown[] }
  | { readonly status: "rejected"; readonly diagnostics: readonly unknown[] }
  | { readonly status: "bridge_error"; readonly error: unknown }

export type InspectResult = CheckResult & { readonly views?: Readonly<Record<View, unknown>> }

export type ExecutionResult<O> =
  | { readonly status: "not_started"; readonly diagnostics: readonly unknown[] }
  | { readonly status: "completed"; readonly result: O; readonly facts: ExecutionFacts }
  | { readonly status: "failed"; readonly error: unknown; readonly facts: ExecutionFacts }
  | { readonly status: "cancelled"; readonly facts: ExecutionFacts }
  | { readonly status: "bridge_error"; readonly error: unknown }

export interface ExecutionFacts {
  readonly artifact?: Uint8Array
  readonly actionRecords: readonly unknown[]
  readonly traces: readonly unknown[]
  readonly resources: Readonly<Record<string, number>>
}

export interface ScriptedAction {
  readonly operation: OperationId
  readonly input: unknown
  readonly authorisation?: "allowed" | "rejected"
  readonly outcome: unknown
}

export interface TestRequest<K extends PropertyKey, I, O> {
  readonly name: string
  readonly slot: K
  readonly program: Program
  readonly input: I
  readonly actions?: readonly ScriptedAction[]
  readonly fixed?: {
    readonly instant?: Instant
    readonly randomSeed?: Uint8Array
    readonly invocationId?: InvocationId
    readonly idempotencySeed?: Uint8Array
  }
  readonly expect: {
    readonly status: ExecutionResult<O>["status"]
    readonly result?: O
    readonly effects?: readonly string[]
    readonly resources?: Partial<Readonly<Record<string, number>>>
  }
}

export interface TestReport {
  readonly passed: boolean
  readonly mismatches: readonly { readonly path: string; readonly expected: unknown; readonly actual: unknown }[]
  readonly execution: ExecutionResult<unknown>
}

export interface SafeScript<O extends Operations, S extends Slots, C> {
  check<K extends keyof S>(request: CheckRequest<K>): Promise<CheckResult>
  inspect<K extends keyof S>(request: InspectRequest<K>): Promise<InspectResult>
  execute<K extends keyof S>(request: ExecuteRequest<K, unknown, C>): Promise<ExecutionResult<unknown>>
  test<K extends keyof S>(request: TestRequest<K, unknown, unknown>): Promise<TestReport>
  cancel(invocationId: InvocationId): Promise<"accepted" | "not_active">
  close(): Promise<void>
}

export declare function createSafeScript<C, O extends Operations, S extends Slots, PolicyError>(
  options: CreateSafeScriptOptions<C, O, S, PolicyError>,
): SafeScript<O, S, C>

