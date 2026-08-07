# SafeScript release notes

## 1.0.0 — 2026-08-08

SafeScript V1 ships the TypeScript host SDK, transport-neutral `RuntimeBridge`, restricted TypeScript compiler, bounded typed-IR interpreter, deterministic test interface, semantic inspection, offline CLI, and adapter-neutral conformance corpus.

The release supports language 1.0 and its additive 1.1 surface, IR 1.0 and 1.1 artefacts, ABI 1.0, diagnostic catalog 1.0.0, and authoring bundle 1.0.0. Compatibility is checked independently for each version dimension and contract requirement.

Release evidence includes canonical encoding and malformed-input rejection, ambient-authority denial, hostile-input resource bounds, current authorisation and typed action outcomes, cancellation without replay, deterministic time and randomness, stable diagnostics and semantic graphs, the locked resource schedule, four reference integrations, and the remediated blind-agent authoring baseline.

This release does not provide or claim optional source storage, artefact caching, durable audit storage, retries, approvals, workflows, durable continuations, Wasm execution, checked visual or semantic editing, or process-based Python, Go, and Rust SDKs. Those remain deferred until justified by later product work.
