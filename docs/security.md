# Security model

SafeScript confines extension code by construction: it accepts a closed language, interprets verified typed IR, validates every value, meters semantic work, and routes effects through a host-owned gateway. It does not rely on generated JavaScript isolation as its primary boundary.

## Trust boundary

Untrusted inputs include:

- extension source and submitted module sets;
- checked artifact bytes loaded from any cache or store;
- invocation inputs and requested lower limits;
- runtime-bridge messages from a process adapter;
- handler results and action outcomes until validated.

Trusted components include:

- the SafeScript compiler, IR verifier, interpreter, codecs, and direct bridge;
- the SDK gateway;
- the host's contract construction, lifecycle hooks, operation handlers, and downstream services;
- any process adapter and transport endpoint that the host chooses to run.

Trusted does not mean infallible. The public boundaries still validate registry records, canonical bytes, correlations, results, limits, and versions and map unexpected implementation failures to stable fail-closed outcomes.

## No ambient authority

Extensions have no filesystem, network, process, package, environment, credential, timer, or general host-object access. Source imports only compiler-provided modules and registered source modules. Deterministic time and randomness require invocation-provided values. `console` creates trace records rather than performing I/O.

A host operation is the only path to an external effect. Its generated declaration exposes data types, not service clients, credentials, database handles, or host policy state.

## Static eligibility versus host authority

The compiler checks that every reachable action's effect and capability are allowed by the selected slot and reports a summary. That protects against source requesting operations outside its declared envelope.

The summary is not authorization. At runtime, the gateway revalidates every action before any hook or handler. A host may enforce current authority in an optional `beforeAction` hook, its trusted handler, a downstream service, or several layers. A previously checked artifact crosses exactly the same gateway and configured host callbacks as source execution.

SafeScript guarantees the validated interception point, not authorization. A deliberate `beforeAction` stop supplies the matched operation's declared error and returns to the extension as an ordinary `Result`. A thrown or malformed before-hook fails closed rather than defaulting to handler dispatch. An absent or permissive hook makes no security claim about the handler or downstream service.

## Typed action boundary

An action request binds:

- ABI, contract requirement, slot, invocation, and request identity;
- operation, effect, and capability identity;
- verified IR and source action-site provenance;
- canonical typed input;
- optional derived idempotency key.

The gateway rejects mismatched, unknown, duplicate, malformed, over-capacity, or uncorrelated requests before hooks and handler dispatch. The outcome must correlate to the request and contain a canonical declared result or an explicit host failure. Host context, hooks, credentials, and hook diagnostics remain outside a runtime worker.

Recording a request proves only that work was proposed. Recording a completed outcome proves that the gateway fixed a valid declared result, supplied either by a stopping hook or a handler. Neither record is a durable audit log, and a failed outcome with `effectState: "unknown"` does not prove that no external effect occurred.

## Fail-closed behavior

The engine and SDK avoid exposing partial work at checked boundaries:

- invalid source, contract, ABI, version, slot, module set, or artifact never starts interpretation;
- invalid invocation input never reaches the bridge;
- resource capacity for an action group is reserved before dispatch;
- a validated `beforeAction` stop does not call the handler;
- malformed or throwing before-hooks, action output, or handler results fail closed;
- after-hook failures cannot replace fixed outcomes and expose only bounded SDK-owned diagnostics;
- raw exceptions and stack traces do not cross the public bridge;
- cancellation ignores late completion and never replays an action;
- semantic graph export fails atomically and cannot affect executable meaning.

## Resource safety

Compile and execution ceilings bound source volume, compiler work, recursion, loops, canonical values, allocations, collections, host calls, concurrency, traces, and output. Limits are semantic and deterministic rather than wall-clock or JavaScript-engine instruction counts.

These controls reduce denial-of-service risk within the SafeScript model, but the trusted host must also bound handler latency, external service consumption, process memory, and transport behavior. SafeScript's `timeout` failure code does not itself create a distributed transaction or cancel an external service operation.

## Idempotency and retries

For operations marked `idempotency: "required"`, the runtime derives a stable key from the invocation's host seed and canonical action facts. The host handler must apply that key at the external effect boundary.

SafeScript does not coordinate retries. It never retries an action automatically, and `unknown` effect state is explicitly unsafe to retry without domain-specific reconciliation. Durable retry, deduplication windows, compensation, and recovery belong to the host.

## Storage and privacy

The host decides whether to retain source, artifacts, semantic graphs, traces, inputs, outputs, and action facts. SafeScript does not persist them automatically. These records can contain application data and should follow the host's retention, tenancy, access-control, and deletion policies.

Checked artifacts contain executable derived representation and contract/source fingerprints, but no credentials or cached host decisions. Semantic graphs can include constants and source-derived facts. Treat both according to the source program's sensitivity.

## Security non-goals

SafeScript is not an approval system, policy language, secrets broker, workflow engine, durable runtime, retry coordinator, or host-service sandbox. It cannot protect against absent or over-permissive host policy, a malicious trusted hook or handler, or a downstream service that grants too much. It cannot roll back external effects.

For implementation details, read [architecture and engine](engine.md). For host integration rules, read the [SDK guide](sdk.md).
