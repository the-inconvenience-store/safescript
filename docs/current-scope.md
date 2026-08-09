# Current scope and roadmap

This page separates repository behavior from architectural direction. It is intentionally conservative: a feature belongs under “implemented” only when the current source and conformance suite exercise it.

## Implemented now

The repository currently implements:

- language-neutral contracts, stable identities, canonical schemas/codecs, version checks, limits, and failure catalog;
- restricted TypeScript language 1.0 and additive 1.1;
- complete registered source-module sets with generated `host:api` and deterministic prelude/globals;
- SafeScript-owned compilation to verified typed IR without generated-JavaScript execution;
- direct in-process `RuntimeBridge` for check, inspect, execute, cancel, and close;
- checked artifact creation and fail-closed verification;
- bounded IR interpretation with deterministic fuel and value/resource accounting;
- sequential actions and bounded deterministic `Promise.all` groups;
- typed action ABI 2.0 requests/outcomes, optional execution/action lifecycle hooks, idempotency-key derivation, and at-most-once handler dispatch per request;
- deterministic fixed time, seeded randomness, checked JSON/bytes/math/string/object/collection intrinsics, and bounded traces;
- semantic graph inspection with stable semantic IDs and independent export limits;
- host contract declaration/codecs/fingerprint derivation;
- the six-method TypeScript facade and deterministic scripted-action tests;
- slot-scoped agent/editor authoring bundles with repair guidance;
- offline JSON CLI commands for check, inspect, execute, and test;
- the worker protocol 1.0 specification, standalone runtime worker, explicit process bridge adapter, and lazy restart-bounded supervisor;
- adapter-neutral conformance references, resource ledgers, hostile cases, release metadata, and authoring evidence;
- an interactive CRM integration and read-only semantic-graph projection.

The public TypeScript packages and CLI are version 1.0.0. The supported compatibility dimensions include language 1.0 and 1.1, IR 1.0 and 1.1, action ABI 2.0, worker protocol 1.0, diagnostic catalog 1.2.0, and authoring bundle 1.0.0.

## Host responsibilities, not missing runtime features

The host deliberately owns:

- user/tenant/resource authorization policy;
- trusted operation implementations and external service credentials;
- idempotency enforcement at the effect boundary;
- source, artifact, trace, graph, and audit retention;
- invocation scheduling and product-level timeouts;
- retries, reconciliation, compensation, and durable recovery;
- visual projection and source-editing user experience;
- deployment isolation around the trusted host process.

These concerns are outside SafeScript's core contract rather than implied automatic behavior.

## Deferred

The current repository does not yet provide:

- worker-backed default selection, concrete child-process launch/package verification, and platform hardening recipes;
- Python, Go, Rust, Java, or C# host SDKs;
- a WebAssembly execution backend;
- artifact cache/storage/signing/export products;
- checked semantic source-edit transformations;
- a general visual editor product;
- durable invocations, workflow coordination, approvals, retries, or audit persistence;
- package ecosystems or arbitrary TypeScript/JavaScript compatibility.

Future adapters must preserve the same serializable bridge contracts and pass the same conformance suite. Future execution backends must preserve the language semantics, action ABI, deterministic resource schedule, compatibility rules, and fail-closed behavior.

## Product boundary

SafeScript is a platform extension kit: a host defines a narrow programmable surface and retains authority over every external effect. It is not a replacement for a workflow engine, policy engine, secrets system, or general JavaScript sandbox.

For the motivation and positioning, return to the [introduction](introduction.md). For implementation details, read [architecture and engine](engine.md).
