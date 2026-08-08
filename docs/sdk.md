# TypeScript SDK guide

`@safescript/sdk` is the host-facing integration layer. It derives a contract, connects trusted handlers and current authorization, validates all bridge values, and exposes one six-method facade: `check`, `inspect`, `execute`, `test`, `cancel`, and `close`.

For a runnable first integration, start with [getting started](getting-started.md). This guide focuses on behavior and lifecycle rather than listing every exported type.

## Define once at host startup

Call `defineContract` with stable types, operations, and slots, then pass the result to `createSafeScript`. Both functions reject configuration problems synchronously. Contract validation catches duplicate or malformed IDs, conflicting schemas, declaration-name collisions, invalid versions or limits, missing slot permissions, and error types that cannot represent policy rejection.

`createSafeScript` requires exactly one handler for every operation and an authorization function. By default it creates an independent direct in-process engine bridge; a host can inject another conforming bridge.

```ts
const safe = createSafeScript({
  contract,
  handlers,
  authorise,
  defaultCompileLimits: { sourceBytes: 128 * 1024 },
  defaultExecutionLimits: { fuel: 20_000, hostCalls: 4 },
});
```

## Check source

`check` compiles a complete source module set for one named slot. It returns one of:

- `accepted`, with checked artifact bytes, reachable effect/capability summary, compiler provenance, usage, and diagnostics;
- `rejected`, with stable diagnostics and compile usage;
- `bridge_error`, for an invalid envelope, incompatible bridge, closed facade, or adapter failure.

Accepted diagnostics can contain bounded non-fatal information; use `status`, not array emptiness, as the decision. A summary is static eligibility information and never current authorization.

## Inspect source

`inspect` performs the same check and optionally derives read-only views. The current view is `semantic_graph`. Graph generation has independent node, edge, and byte limits; source can be accepted while a requested graph reports `graph_limit_exceeded`. No partial graph is returned.

See [artifacts and inspection](artifacts-and-inspection.md) before building an editor or analysis tool.

## Execute source or an artifact

`execute` accepts either source or checked artifact bytes. It validates the slot input with the contract codec before calling the bridge and decodes a completed output back to the slot's host-side TypeScript type.

Useful invocation inputs include:

- `context`: host-local data available only to authorization and handlers, never to the runtime bridge;
- `invocationId`: optional host-chosen correlation identity;
- `idempotencySeed`: required to derive keys for operations marked `required`;
- `fixedInstant`: deterministic value for `Temporal.Now.instant()`;
- `randomSeed`: deterministic source for `Math.random()`;
- `limits`: invocation ceilings that can only lower configured ceilings;
- `trace`: `none`, `summary`, or `semantic`;
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

1. validates ABI, invocation, contract, slot, operation, effect, capability, action site, and source correlation;
2. decodes the action input with the declared schema;
3. runs the operation's pure `resourceScope` extractor;
4. constructs `ActionContext` with host context, request facts, scope, optional idempotency key, and abort signal;
5. awaits the current authorization decision;
6. dispatches the matching handler at most once if allowed;
7. validates the returned `Result` or explicit handler failure;
8. encodes a correlated action outcome.

Throws, malformed decisions, invalid scopes, extra result fields, schema mismatches, or uncorrelated bridge requests fail closed. Handler exceptions become `handler_fault` with effect state `unknown`; they are not exposed to extension code or returned with a stack trace.

Handlers can return a declared `Result` or an explicit infrastructure failure:

```ts
return {
  status: 'failed',
  effectState: 'not_performed', // or "unknown"
  failure: { code: 'unavailable', detail: 'Task service unavailable' },
};
```

## Authorization and idempotency

Authorization runs per request using current host state. It receives the complete validated action request, host-local invocation context, resource scope, cancellation signal, and—when required—a derived idempotency key.

The key is derived from a host-provided seed plus the contract, operation, action site, sequence, and canonical input. SafeScript only derives and supplies the key; the trusted handler or downstream service must enforce it. Request IDs are correlation IDs and do not deduplicate effects.

## Deterministic tests

`safe.test` runs the same compiler and runtime bridge with a scripted action host. It never calls production authorization or handlers. A test can fix time, randomness, invocation ID, and idempotency seed; script ordered actions and outcomes; and compare status, output, effects, actions, diagnostics, and resource counters.

It returns `{ passed, mismatches, execution }` and does not throw for an extension mismatch. See [testing and conformance](testing.md) for examples.

## Cancellation and close

`cancel(invocationId)` aborts the SDK-side signal and asks the bridge to cancel the matching active invocation. It is idempotent: no matching active invocation returns `not_active`. Cancellation does not imply rollback and late host completion is ignored.

`close()` is idempotent, aborts facade invocations, waits for active facade calls, and closes the bridge. Calls begun after closing receive stable `bridge_closed` results. Create separate facades or bridges when you need independent lifecycles.

## Authoring support

`createAuthoringBundle(contract, slot)` produces slot-scoped declarations, restrictions, examples, and structured diagnostic repair guidance for an editor or coding agent. It intentionally excludes private IR and semantic graph internals. See [authoring bundles](artifacts-and-inspection.md#authoring-bundles).
