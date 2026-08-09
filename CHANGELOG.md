# SafeScript release notes

## 2.0.0 — 2026-08-09

SafeScript V2 makes the pinned supervised local runtime worker the SDK's worker-backed default while retaining the direct in-process bridge as an explicit conformant option. The coordinated release contains `@safescript/contracts`, `@safescript/engine`, `@safescript/worker`, `@safescript/sdk`, `@safescript/cli`, and `@safescript/conformance` at 2.0.0 for Node.js 22 and 24.

The release freezes worker protocol 1.0, action ABI 2.0, language 1.0 and 1.1, IR 1.0 and 1.1, diagnostic catalog 1.4.0, artifact 1.0, authoring bundle 1.0.0, the public worker failure meanings, package layout, supported platform matrix, canonical fixture schema 1.0.0, and migration guidance. Host hooks, handlers, context, credentials, policy state, and hook diagnostics remain outside the worker protocol.

V1 source and contracts remain canonical inputs and run unchanged after upgrade. Checked artifacts are disposable compiler-bound optimizations: retain source and perform artifact regeneration with the V2 contract and worker set. Worker loss never replays an invocation or action, and unknown effect state requires host reconciliation before any application-level retry.

Release evidence covers canonical and hostile protocol bytes, direct/worker semantic equivalence, bounded supervision and flow control, secret sentinels, installed-package smoke tests, v1-to-v2 source and contract upgrade, artifact regeneration, dependency audit, and the complete Node/OS/architecture matrix.

## 1.0.0 — 2026-08-08

SafeScript V1 ships the TypeScript host SDK, transport-neutral `RuntimeBridge`, restricted TypeScript compiler, bounded typed-IR interpreter, deterministic test interface, semantic inspection, offline CLI, and adapter-neutral conformance corpus.

The release supports language 1.0 and its additive 1.1 surface, IR 1.0 and 1.1 artefacts, ABI 1.0, diagnostic catalog 1.0.0, and authoring bundle 1.0.0. Compatibility is checked independently for each version dimension and contract requirement.

Release evidence includes canonical encoding and malformed-input rejection, ambient-authority denial, hostile-input resource bounds, current authorisation and typed action outcomes, cancellation without replay, deterministic time and randomness, stable diagnostics and semantic graphs, the locked resource schedule, four reference integrations, and the remediated blind-agent authoring baseline.

This release does not provide or claim optional source storage, artefact caching, durable audit storage, retries, approvals, workflows, durable continuations, Wasm execution, checked visual or semantic editing, or process-based Python, Go, and Rust SDKs. Those remain deferred until justified by later product work.
