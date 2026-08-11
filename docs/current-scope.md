# Current scope and roadmap

This page separates repository behavior from architectural direction. It is intentionally conservative: a feature belongs under “implemented” only when the current source and conformance suite exercise it.

## Implemented now

The repository currently implements:

- language-neutral contracts, stable identities, canonical schemas/codecs, limits, and failure catalog;
- the restricted TypeScript language described in the language guide;
- one explicitly named source module with generated `host:api` and deterministic prelude/globals;
- SafeScript-owned compilation to verified typed IR without generated-JavaScript execution;
- supervised worker-backed default and explicit direct in-process `RuntimeBridge` for check, inspect, execute, cancel, and close;
- bounded bridge-local caching of accepted verified compilations;
- explicit optional checked-artifact creation and fail-closed verification;
- optional SDK read-through and write-through integration with a host-provided artifact store;
- bounded IR interpretation with deterministic fuel and value/resource accounting;
- sequential directly awaited actions;
- typed action requests/outcomes, optional validated `beforeAction` policy, and at-most-once handler dispatch per request;
- deterministic fixed time, seeded randomness, checked JSON/bytes/math/string/object/collection intrinsics, and bounded traces;
- tagged semantic graph 1.0 inspection with source-complete editable boundaries, stable semantic IDs, ordered anchors, explicit semantic relationships, and independent export limits;
- semantic edit schema 1.0 contracts with a closed 30-operation algebra, capability-view records, preconditions, independent limits, atomic result/diff/diagnostic unions, strict hostile-input validators, and canonical worker payload records;
- a private lossless semantic transformation kernel with UTF-8 source indexing, deterministic comment ownership and fragment printing, conflict planning, provenance mapping, final-source checking, and independent limit accounting;
- host contract declaration/codecs/fingerprint derivation;
- the six-method TypeScript facade and deterministic scripted-action tests;
- slot-scoped agent/editor authoring bundles with repair guidance;
- offline JSON CLI commands for check, inspect, execute, and test;
- the worker protocol specification, standalone runtime worker, pinned manifest-verified Node launcher, default process bridge adapter, and lazy terminal-failure supervisor;
- adapter-neutral conformance references, resource measurements, hostile cases, release metadata, and authoring evidence;
- an interactive CRM integration and read-only semantic-graph projection.

The coordinated public TypeScript package set and sole public compatibility contract is SafeScript 0.7.0. Internal envelope and artifact format markers are validation details, not independently selectable product versions.

## Host responsibilities, not missing runtime features

The host deliberately owns:

- user/tenant/resource authorization policy;
- trusted operation implementations and external service credentials;
- business-key selection, persistence, and idempotency enforcement at the effect boundary;
- source, artifact, trace, graph, and audit retention;
- invocation scheduling and product-level timeouts;
- retries, reconciliation, compensation, and durable recovery;
- visual projection and source-editing user experience;
- deployment isolation around the trusted host process.

These concerns are outside SafeScript's core contract rather than implied automatic behavior.

## Deferred

The current repository does not yet provide:

- platform-specific optional hardening recipes beyond the portable spawn contract;
- Python, Go, Rust, Java, or C# host SDKs;
- a WebAssembly execution backend;
- a SafeScript-provided artifact storage backend, signing, or export product;
- checked semantic source-edit transformations, capability projection, and callable bridge/SDK edit integration;
- a general visual editor product;
- durable invocations, workflow coordination, approvals, retries, or audit persistence;
- package ecosystems or arbitrary TypeScript/JavaScript compatibility.

Future adapters must preserve the same serializable bridge contracts and pass the same conformance suite. Future execution backends must preserve the language semantics, typed action boundary, deterministic release-local resource schedule, exact release contract, and fail-closed behavior. Exact cross-backend fuel totals become normative only when an independent backend is implemented and the shared units are validated.

## Product boundary

SafeScript is a platform extension kit: a host defines a narrow programmable surface and retains authority over every external effect. It is not a replacement for a workflow engine, policy engine, secrets system, or general JavaScript sandbox.

For the motivation and positioning, return to the [introduction](introduction.md). For implementation details, read [architecture and engine](engine.md).
