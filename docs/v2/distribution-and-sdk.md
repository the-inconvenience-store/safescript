# Runtime worker distribution and TypeScript SDK behavior

This document defines how the v2 TypeScript SDK obtains, launches, verifies, and supervises its default local runtime worker.

## Package set

The v2 release set contains `@safescript/contracts`, `@safescript/engine`, `@safescript/worker`, `@safescript/sdk`, `@safescript/cli`, and `@safescript/conformance`. Public packages in one stable release use the same product version and publish coordinated protocol/conformance metadata.

`@safescript/sdk` declares an exact dependency on the matching `@safescript/worker` version. The worker declares exact compatible engine/contracts dependencies. The installation MUST contain all JavaScript needed to start the worker; it MUST NOT download an executable in `postinstall`, require a system daemon, compile native code, or discover packages from ambient search paths.

The worker package exposes a documented ESM entry point and a generated build manifest containing package version, worker protocol versions, compiler identity, entry-point path, and SHA-256 build digest.

## Worker resolution

By default the SDK resolves the worker package relative to its own installed package graph, not the application working directory, `PATH`, environment variables, or global packages. It compares the resolved package version and build manifest with values embedded in the SDK release before spawn.

Resolution failure is `worker_start_failed`. Version or digest mismatch is `worker_identity_mismatch`. Neither condition silently falls back to a different worker, an older protocol, or the direct bridge.

## Launch behavior

In a supported Node process the SDK launches the resolved entry point with `process.execPath`, an exact argv array, `shell: false`, and the [spawn contract](security.md#spawn-contract). A non-Node JavaScript runtime must provide an explicitly configured supported Node executable or explicitly select the direct bridge.

Worker startup is lazy and shared by concurrent initial facade calls. The SDK connects binary stdin/stdout, reserves stdout for protocol, captures bounded stderr, performs the mandatory handshake, and exposes no successful bridge operation before readiness. Startup, handshake, crash-rate, and close behavior follow the [lifecycle](state-machine-and-lifecycle.md).

No worker process is shared implicitly between facade instances, applications, users, or tenants. Hosts that intentionally implement pooling do so outside the v2 reference adapter and remain responsible for equivalent isolation and conformance.

## Worker identity

The SDK has two identity checks:

1. before spawn, installed package metadata and the generated build manifest match the SDK-pinned release;
2. during handshake, the worker reports the expected package version, compiler build, protocol support, and build digest.

Both MUST pass for the bundled worker. Identity proves the selected installed build, not authorization or absence of compromise. All worker messages remain untrusted and every action still crosses the validated host gateway; whether the host enforces authorization there is host policy.

## Explicit override

An integration MAY configure an absolute worker entry-point path and Node executable explicitly. Override values are data, never shell text; relative paths, command strings, and ambient `PATH` lookup are rejected.

An override configuration states its permitted protocol range, required features, and optionally a SHA-256 digest allow-list. Without an allow-list the SDK records that integrity is operator-owned. Overrides still perform the full handshake and all per-request validation. They do not enable remote transports, daemon discovery, automatic downgrade, or fallback.

## TypeScript facade behavior

`createSafeScript` uses the supervised process bridge by default in v2 while preserving its six public methods: `check`, `inspect`, `execute`, `test`, `cancel`, and `close`. Contract declaration, handlers, optional lifecycle hooks, invocation context, codecs, deterministic tests, and public result unions remain SDK concerns. The facade invokes hooks on the host side of either bridge; hook callbacks, host context, credentials, policy state, and hook diagnostics are never encoded into worker messages.

The direct in-process bridge remains a supported explicit option for development, conformance, deterministic unit/integration tests, and constrained deployments. It passes the same semantic conformance suite but does not claim process containment. Selecting it is deliberate configuration and is never an automatic response to worker failure.

Facade construction remains synchronous; worker startup occurs on first method use. `close` is idempotent. Worker loss completes in-flight calls with stable bridge failures and never replays them. Future calls may start a fresh worker only under the supervisor policy.

## Supported platforms

The minimum v2 release matrix is:

- Node.js 22 and 24 on Linux x64 and arm64;
- Node.js 22 and 24 on macOS x64 and arm64;
- Node.js 22 and 24 on Windows x64.

The package `engines` field declares Node `>=22 <25` for the v2.0 release line. Every listed target MUST pass the same adapter-neutral conformance corpus before stable publication. A release MAY add a platform with evidence; removing a target or raising the minimum runtime follows product compatibility policy. Protocol compatibility itself is OS- and architecture-neutral.
