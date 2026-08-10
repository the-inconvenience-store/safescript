# SafeScript release notes

## 0.6.0 — 2026-08-10

SafeScript 0.6.0 provides the restricted TypeScript compiler, bounded typed-IR interpreter, TypeScript host SDK, deterministic test interface, semantic inspection, offline CLI, conformance corpus, and pinned supervised local runtime worker.

All public packages and internal SafeScript dependencies use the coordinated 0.6.0 version. The worker handshake requires that exact SafeScript version and the expected worker build digest; source contracts and runtime records do not expose independent language, IR, ABI, diagnostic-catalog, artifact, or authoring-bundle compatibility selectors.

The worker-backed SDK is the default, with the direct in-process bridge available as an explicit conformant option. Worker loss never replays an invocation or action, and unknown effect state requires host reconciliation before any application-level retry.

Release evidence covers canonical and hostile protocol bytes, direct/worker semantic equivalence, bounded supervision and flow control, secret sentinels, installed-package smoke tests, dependency audit, and the Node 22/24 platform matrix.

Storage, artifact caching, durable audit, retries, approvals, workflows, durable continuations, Wasm execution, checked visual editing, and non-TypeScript host SDKs remain outside this prerelease.
