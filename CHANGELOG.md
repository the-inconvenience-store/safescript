# SafeScript release notes

## 0.7.0 — 2026-08-10

SafeScript 0.7.0 removes unused compatibility and orchestration machinery. It also adds a bounded in-memory compilation cache and optional host-owned artifact storage. This release contains the changes from the full YAGNI review after 0.6.0.

### Added

- Added a bounded, bridge-local compiled-program cache. Concurrent requests for the same program share one compilation. Count and retained-weight limits control eviction.
- Added optional read-through and write-through artifact storage. The host supplies the storage adapter and owns tenancy, retention, durability, and operations. SafeScript verifies stored artifacts and falls back to source compilation after a corrupt entry or storage failure.

### Changed

- Replaced trace detail modes with the `trace` boolean.
- Removed type-instantiation work and diagnostic-count knobs. Compile limits now use direct resource ceilings and the `includeDiagnostics` boolean.
- Replaced operation-specific fuel weights with a release-local additive fuel schedule.
- Reduced action permissions and artifact effect summaries to operation IDs. Runtime authorization remains a current host decision.
- Reduced lifecycle policy hooks to the optional `beforeAction` hook.
- Reduced each source program to one module and removed entry-module selection and module arrays.
- Made worker startup failure and worker loss terminal for one SafeScript facade. The host can replace the facade, but SafeScript does not restart it or replay work.

### Removed

- Removed the legacy flat IR and its compatibility verification path. Structured IR is the only executable IR.
- Removed redundant retained-byte accounting from execution limits and resource usage.
- Removed SDK-owned idempotency keys, seeds, modes, and replay state. Idempotency is entirely a host responsibility.
- Removed empty worker feature negotiation. The exact coordinated SafeScript version is the compatibility contract.
- Removed concurrent action groups and `Promise.all` action lowering. Extension actions execute sequentially.

### Compatibility

- All public packages and internal SafeScript dependencies now use the coordinated 0.7.0 version.
- The worker handshake and published protocol fixtures require the exact 0.7.0 identity.
- This release changes public request, limit, permission, hook, source, and worker-lifecycle contracts. Hosts must update affected integrations before upgrade.

## 0.6.0 — 2026-08-10

SafeScript 0.6.0 provides the restricted TypeScript compiler, bounded typed-IR interpreter, TypeScript host SDK, deterministic test interface, semantic inspection, offline CLI, conformance corpus, and pinned supervised local runtime worker.

All public packages and internal SafeScript dependencies use the coordinated 0.6.0 version. The worker handshake requires that exact SafeScript version and the expected worker build digest; source contracts and runtime records do not expose independent language, IR, ABI, diagnostic-catalog, artifact, or authoring-bundle compatibility selectors.

The worker-backed SDK is the default, with the direct in-process bridge available as an explicit conformant option. Worker loss never replays an invocation or action, and unknown effect state requires host reconciliation before any application-level retry.

Release evidence covers canonical and hostile protocol bytes, direct/worker semantic equivalence, bounded supervision and flow control, secret sentinels, installed-package smoke tests, dependency audit, and the Node 22/24 platform matrix.

Storage, artifact caching, durable audit, retries, approvals, workflows, durable continuations, Wasm execution, checked visual editing, and non-TypeScript host SDKs remain outside this prerelease.
