# TypeScript SDK guide

`@safescript/sdk` is the host-facing integration layer. It derives a contract, connects trusted handlers and an optional host-local action-policy hook, validates all bridge values, and exposes one six-method facade: `check`, `inspect`, `execute`, `test`, `cancel`, and `close`.

For a runnable first integration, start with [getting started](getting-started.md). This guide focuses on behavior and lifecycle rather than listing every exported type.

## Define once at host startup

Call `defineContract` with stable types, operations, and slots, then pass the result to `createSafeScript`. Both functions reject configuration problems synchronously. Contract validation catches duplicate or malformed IDs, conflicting schemas, declaration-name collisions, invalid limits, and missing slot permissions.

`createSafeScript` requires exactly one handler for every operation. The `beforeAction` hook is optional. By default it creates an independent, lazy `SupervisedProcessRuntimeBridge` using the pinned local Node worker. A host can inject another conforming bridge; explicit direct mode is `bridge: createDirectRuntimeBridge()`. `ProcessRuntimeBridge` owns one already-created worker connection, enforces the negotiated codec, credit, queue, partial-frame, and stderr limits, and exposes its bounded operator-only stderr tail through `capturedStderr()`. `SupervisedProcessRuntimeBridge` adds lazy shared readiness, bounded close policy, and terminal failure without replay.

`createNodeProcessRuntimeBridge()` adds the concrete local-process boundary. Its default path resolves the exact `@safescript/worker` dependency, verifies the package metadata, generated build manifest, and pinned bundle digest before spawn, then launches the entry with the current Node executable, an empty environment, three pipe handles, and `shell: false`. A non-Node host supplies an absolute `nodePath`. An explicit override requires an absolute entry path, remains subject to the exact handshake, and may require a SHA-256 digest allow-list.

```ts
const safe = createSafeScript({
  contract,
  handlers,
  hooks: {
    beforeAction: hostPolicy,
  },
  defaultCompileLimits: { sourceBytes: 128 * 1024 },
  defaultExecutionLimits: { fuel: 20_000, hostCalls: 4 },
  artifactStore: hostArtifactStore,
  artifactStoreTimeoutMs: 1_000,
});
```

`artifactStore` is optional. Without it, SafeScript has no persistent cache dependency and ordinary source work uses only the bounded bridge-local cache. With it, source execution uses host-provided read-through and write-through storage. SafeScript derives opaque keys and verifies all loaded bytes. The host owns the storage technology and its security, tenancy, retention, eviction, durability, and operations. See [artifacts and inspection](artifacts-and-inspection.md#optional-host-artifact-storage).

To select direct mode deliberately:

```ts
import { createDirectRuntimeBridge } from '@safescript/engine';

const safe = createSafeScript({
  contract,
  handlers,
  bridge: createDirectRuntimeBridge(),
});
```

There is no automatic direct fallback or worker restart. `worker_start_failed`, `worker_start_timeout`, `worker_identity_mismatch`, `worker_lost`, and `worker_close_timeout` are stable operational failures. Startup failure or worker loss permanently fails that facade. Later calls return the retained cause without spawning a worker. The host can close and replace the facade under its own restart and backoff policy, but it must not replay a lost invocation. An unresolved external effect remains unknown unless the host can prove otherwise. See [limits and diagnostics](limits-and-diagnostics.md) and the [worker lifecycle](worker-lifecycle.md).

## Check source

`check` compiles one explicitly named source module for one named slot. It returns one of:

- `accepted`, with reachable operation summary, compiler provenance, usage, and diagnostics;
- `rejected`, with stable diagnostics and compile usage;
- `bridge_error`, for an invalid envelope, incompatible bridge, closed facade, or adapter failure.

Accepted diagnostics can contain bounded non-fatal information; use `status`, not array emptiness, as the decision. A summary is static eligibility information and never current authority.

Accepted checks omit artifact bytes by default. Set `includeArtifact: true` when the host needs bytes for later artifact execution or host-managed storage. Normal source work reuses a private bounded cache inside the direct bridge or worker and does not serialize IR.

## Inspect source

`inspect` performs the same check and optionally derives read-only views. Request the current view with a tagged `{ kind: 'semantic_graph', schema: { major: 1, minor: 0 }, limits }` record. Accepted inspection results contain a correlated `views` array whose element is independently accepted with bytes or rejected with `graph_limit_exceeded`. Graph generation has independent node, edge, and byte limits; no partial graph is returned.

The contracts package also publishes the schema-1.0 `semantic_edit_capabilities` view and `ApplySemanticEditsRequest`/`ApplySemanticEditsResult` records. They are the stable integration surface for semantic editing, but the current six-method facade and runtime bridges do not yet project capabilities or apply edits. Callers must not send those records through `inspect` or a worker session until the integration stage lands.

See [artifacts and inspection](artifacts-and-inspection.md) before building an editor or analysis tool.

## Execute source or an artifact

`execute` accepts either source or checked artifact bytes. It validates the slot input with the contract codec before calling the bridge and decodes a completed output back to the slot's host-side TypeScript type.

For a source program, `includeArtifact: true` adds serialized bytes to source preparation facts. It is false by default and does not change execution semantics.

The optional artifact store is used only by source `execute`. It does not run during `check`, `inspect`, artifact-only execution, or deterministic `test`. Misses, corrupt entries, adapter failures, and adapter timeouts fall back to source compilation. Artifact-only execution has no fallback.

Useful invocation inputs include:

- `context`: host-local data available only to `beforeAction` and handlers, never to the runtime bridge;
- `invocationId`: optional host-chosen correlation identity;
- `fixedInstant`: deterministic value for `Temporal.Now.instant()`;
- `randomSeed`: deterministic source for `Math.random()`;
- `limits`: invocation ceilings that can only lower configured ceilings;
- `trace`: `true` to collect bounded trace records; omitted or `false` to disable collection;
- `signal`: external cancellation.

Execution returns closed status unions rather than leaking compiler or handler exceptions:

- `not_started` when source checking or preparation fails;
- `completed` with decoded output and execution facts;
- `failed` with a stable execution error and facts;
- `cancelled` with facts up to cancellation;
- `bridge_error` for adapter/envelope/lifecycle failure.

Every started result includes preparation provenance, ordered requested/resolved action records, bounded trace data, resource usage, and the invocation ID selected by the SDK.

## The gateway sequence

When execution reaches an action, the SDK gateway:

1. validates invocation, contract, slot, operation, action site, and source correlation;
2. decodes the action input with the declared schema;
3. constructs immutable action context with host context, decoded input, request facts, and abort signal;
4. awaits `beforeAction` when configured;
5. fixes a validated declared `Err` if the hook stops, otherwise dispatches the matching handler at most once;
6. validates the returned `Result` or explicit handler failure;
7. fixes and encodes the correlated action outcome.

Throws, malformed `beforeAction` decisions, extra result fields, schema mismatches, or uncorrelated bridge requests fail closed. Handler exceptions become `handler_fault` with effect state `unknown`; they are not exposed to extension code or returned with a stack trace.

Handlers can return a declared `Result` or an explicit infrastructure failure:

```ts
return {
  status: 'failed',
  effectState: 'not_performed', // or "unknown"
  failure: { code: 'unavailable', detail: 'Task service unavailable' },
};
```

## Host policy, composition, and idempotency

SafeScript provides one validated interception point, not authorization. A host may enforce user, tenant, resource, or service authority in `beforeAction`, its handlers, downstream services, or several layers. `beforeAction` receives the complete validated request, decoded input, host-local invocation context, and cancellation signal. A stop must supply that operation's declared error type.

When several policy checks share this point, the host composes and orders them inside the callback. Keep downstream authorization when the service is reachable through another path or defense in depth is required; an absent or permissive hook does not make a handler safe.

The handler or downstream service owns any domain-specific idempotency key and must select, store, and enforce it. SafeScript invocation, request, and action-site IDs are correlation and provenance facts, not deduplication keys. SafeScript does not retry actions.

For execution-level policy, validate before calling `execute`. For execution observation, await `execute` and inspect its result. For action observation, wrap the relevant handler. These are ordinary host composition and do not require SDK lifecycle machinery.

The key is derived from a host-provided seed plus the contract, operation, action site, sequence, and canonical input. SafeScript only derives and supplies the key; the trusted handler or downstream service must enforce it. Request IDs are correlation IDs and do not deduplicate effects.

## Deterministic tests

`safe.test` runs the same compiler and runtime bridge with a scripted action host. It never calls production policy or handlers. A test can fix time, randomness, and invocation ID; script ordered actions and declared outcomes; and compare status, output, operations, actions, diagnostics, and resource counters.

It returns `{ passed, mismatches, execution }` and does not throw for an extension mismatch. See [testing and conformance](testing.md) for examples.

## Cancellation and close

`cancel(invocationId)` aborts the SDK-side signal and asks the bridge to cancel the matching active invocation. It is idempotent: no matching active invocation returns `not_active`. Cancellation does not imply rollback and late host completion is ignored.

`close()` is idempotent, aborts facade invocations, waits for active facade calls, and closes the bridge. Calls begun after closing receive stable `bridge_closed` results. Create separate facades or bridges when you need independent lifecycles.

## Authoring support

`createAuthoringBundle(contract, slot)` produces slot-scoped declarations, restrictions, examples, and structured diagnostic repair guidance for an editor or coding agent. It intentionally excludes private IR and semantic graph internals. See [authoring bundles](artifacts-and-inspection.md#authoring-bundles).

## Worker distribution

SafeScript 0.7.0 coordinates `@safescript/contracts`, `@safescript/engine`, `@safescript/worker`, `@safescript/sdk`, `@safescript/cli`, and `@safescript/conformance`. Internal SafeScript dependencies use the exact same version. Installation includes the complete JavaScript worker and does not download executables, require a daemon, compile native code, or discover ambient packages.

The SDK resolves the worker relative to its own installed package graph, verifies the generated manifest and SHA-256 build digest, and starts it lazily. An explicit override requires absolute entry and Node paths; an optional digest allow-list further constrains it. Overrides do not enable remote transports, daemon discovery, downgrade, or fallback.

The supported release matrix is Node.js 22 and 24 on Linux x64/arm64, macOS x64/arm64, and Windows x64. Every target runs the same adapter-neutral conformance suite.
