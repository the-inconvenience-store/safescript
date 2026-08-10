# Architecture and engine

The SafeScript engine is the reference compiler and execution runtime behind the transport-neutral `RuntimeBridge`. The TypeScript SDK runs it in the pinned local worker by default. Hosts can inject `createDirectRuntimeBridge()` explicitly when they deliberately want the compiler and interpreter in-process; both adapters use the same serializable bridge records and semantic conformance suite.

## Compilation pipeline

For a check request, the direct bridge:

1. validates the contract registry, slot, source module set, UTF-8, and requested ceilings;
2. measures source, module, import, declaration, syntax-depth, type-depth, template, and diagnostic work;
3. parses with the pinned TypeScript compiler API without invoking ambient module resolution;
4. applies SafeScript-owned syntax, type, control-flow, module, effect, and capability rules;
5. lowers accepted code to typed SafeScript IR;
6. independently verifies structured IR shape and depth, schemas, handler, actions, summaries, and slot permissions;
7. creates a checked artifact bound to source, compiler build, contract, definitions, and slot;
8. returns the artifact, reachable authority summary, provenance, diagnostics, and usage.

The compiler lowers current SafeScript directly into one verified structured IR, allowing helper calls, recursion, loops, destructuring, collections, intrinsics, and action groups. This is a private execution representation; integrations should depend on source, bridge records, and the public semantic graph instead. Legacy flat control-flow IR and its artifacts are not accepted.

The compiler never emits JavaScript for execution.

## Runtime bridge

The bridge has five operations:

- `check` validates and compiles source;
- `inspect` checks source and derives requested disposable views;
- `execute` prepares source or verifies an artifact, then interprets it;
- `cancel` signals an active invocation;
- `close` ends the adapter lifecycle.

The SDK adds its deterministic `test` method above this seam. Bridge inputs and outputs contain canonical bytes and language-neutral records, never host closures, credentials, object handles, compiler objects, or exception instances.

## Execution preparation

Source execution compiles through the same check path and reports the newly created artifact, summary, provenance, diagnostics, and compile usage in `facts.preparation`.

Artifact execution treats bytes as untrusted. The engine rechecks canonical encoding, compiler identity, contract identity, registry digest, referenced definition fingerprints, slot, IR digest, and the complete private IR verifier before interpreting anything. Artifact mode reports its verified IR digest in preparation facts.

An artifact is a disposable optimization, not a permission token. It does not bypass input validation, resource limits, the action gateway, configured host hooks, handler dispatch, or result validation.

## Bounded interpretation

The interpreter evaluates canonical values and verified instructions. A resource meter charges before protected work, including instructions, function entry, loop iterations, allocation, scans, collection traversal, intrinsics, host actions, and output commit. It tracks:

- fuel;
- allocation count and cumulative allocated bytes;
- peak retained bytes and canonical value shape;
- peak collection size and call depth;
- host calls and peak concurrent actions;
- trace and output bytes.

If a limit would be exceeded, execution fails before the operation exposes a partial allocation or action group. The [Semantic resource schedule](resource-schedule.md) defines the charges; [limits and diagnostics](limits-and-diagnostics.md) explains configuration and results.

Arithmetic uses checked SafeScript semantics. Signed integer overflow, division errors, non-finite floating results, malformed canonical values, missing deterministic inputs, invalid IR, and invalid output produce stable execution failures rather than JavaScript behavior leaking through.

## Action suspension

When the interpreter reaches a host operation, it:

1. reserves host-call capacity and fuel;
2. canonically encodes the typed input;
3. constructs a correlated action request with invocation, request, contract, slot, operation, effect, capability, action-site, source, and optional idempotency facts;
4. records the request;
5. suspends only the in-memory invocation while the SDK gateway handles it;
6. validates the correlated terminal outcome;
7. records the resolution and resumes with a declared `Result`, or terminates on a host/infrastructure failure.

Concurrent `Promise.all` groups reserve the whole group first and expose requests in deterministic input order. Resolution records also remain ordered by input, even if host promises complete out of order. The runtime never retries or replays an action.

Suspension is not durable execution. A process failure loses interpreter state unless the host reruns the invocation under its own policy.

## Cancellation and traces

The bridge tracks unique active invocation IDs. Cancellation sets an in-memory signal checked by the interpreter and gateway. It can stop future work and ignore a late action completion; it cannot undo an external effect.

Set `trace` to `true` to collect trace records or `false` to disable collection. Trace records are canonical and byte-bounded. When the trace ceiling is reached, trace collection truncates atomically and marks `truncated` without changing program semantics.

## Semantic inspection

Inspection derives a public semantic program graph from accepted source and verified compiler facts. It is never executable input and never controls lowering. See [artifacts and inspection](artifacts-and-inspection.md) for graph identity, limits, and editor guidance.

## Adapter conformance

The conformance suite exercises adapters only through a bridge factory. It locks reference checks, source/artifact equivalence, semantic graphs, resource ledgers, cancellation, action ordering, deterministic time/randomness/traces, canonical values, hostile boundary cases, and exact release identity. See [testing and conformance](testing.md).
