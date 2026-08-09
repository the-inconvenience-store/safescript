# Worker protocol security

This document extends the [SafeScript security model](../security.md) across the v2 process boundary. Process separation is defense in depth; it does not replace SafeScript language restriction, IR verification, canonical validation, metering, or authority enforced by the host or a downstream service.

## Trust boundary

Source, artifacts, contract registries, invocation inputs, requested limits, protocol frames, worker outputs, action requests, action outcomes, and handler results are untrusted at every receiving seam.

The runtime worker contains the compiler, verifier, and interpreter, but the host adapter treats it as a protocol-untrusted peer. Worker compromise must not directly expose host credentials, handlers, hooks, policy state, arbitrary host objects, or ambient authority. The worker likewise treats the host as a potentially malformed peer and validates every frame before work.

The worker necessarily receives contract metadata, source or artifacts, invocation inputs, deterministic time/random seeds, limits, and action outcomes required for execution. Process separation does not make those values non-sensitive.

## Host-retained authority

Handlers, credentials, invocation context, lifecycle hooks, policy and resource-scope evaluation, external idempotency enforcement, and effect dispatch remain exclusively in the host process. They MUST NOT be serialized to the worker. Hook decisions and hook diagnostics are SDK-local facts and MUST NOT appear in protocol messages or worker execution facts.

Each worker `action.request` is only a typed proposal. The host validates session and execute correlation, ABI and contract facts, operation/effect/capability/action-site identities, canonical input, and idempotency facts before any hook or handler. It MAY then run `beforeAction`; a configured hook may stop with a validated declared operation error, while an absent or continuing hook permits at-most-once handler dispatch. `afterAction` observes the fixed outcome and cannot replace it. Static summaries, successful handshake, checked artifacts, prior hook decisions, and process identity never grant authority.

SafeScript guarantees a validated interception point, not authorization. The host decides whether and where to enforce user, tenant, resource, and service authority: in a lifecycle hook, a handler, a downstream service, or several layers.

## Mutual validation

Both peers MUST apply framing limits before allocation, validate deterministic CBOR and closed schemas, reject unknown fields and variants, and validate all independent version and correlation facts. A payload is not trusted because its envelope is valid.

The host MUST reject duplicate, late, mismatched, uncorrelated, or state-invalid actions without handler dispatch. The worker MUST reject malformed or mismatched action outcomes. Unexpected exceptions become bounded stable failures; stack traces, raw frames, and peer-controlled detail do not cross the public bridge.

Protocol failure closes the smallest trustworthy scope and never triggers retry or replay. A lost unresolved action has unknown effect state unless the host can prove otherwise.

## Spawn contract

The SDK MUST launch an exact worker entry point with the current supported Node executable, an argv array, and `shell: false`. It MUST use:

- a minimal allow-listed environment with no inherited credentials;
- an explicit non-sensitive working directory;
- stdin and stdout exclusively for binary protocol;
- bounded captured stderr;
- no Node IPC channel;
- no inherited file descriptors or handles beyond required stdio;
- no source, input, credential, or secret in argv or environment.

The SDK validates the bundled package version and build digest during handshake. An explicit executable override is opt-in, is never shell parsed, and remains subject to negotiation and optional digest allow-listing.

## Sensitive data

Source, contract constants, artifacts, semantic graphs, invocation values, action values, traces, and execution facts may contain tenant data. The protocol MUST NOT log them by default. Stable lifecycle events carry only necessary version, correlation, limit, exit, and signal facts.

Worker stdout is protocol-only. Stderr uses a bounded ring and is disclosed only to an explicitly configured diagnostic sink after redaction. Default public failures contain no filesystem paths, environment values, process command lines, raw exceptions, stack traces, source snippets, canonical payloads, or credentials. Storage, access, tenancy, deletion, and retention remain host policy.

## Deployment hardening

The portable v2 guarantee is process separation plus spawn hygiene. Operators SHOULD add controls appropriate to their platform and threat model: restricted service accounts, containers, read-only package filesystems, network denial, seccomp or sandbox profiles, process memory/CPU quotas, and parent-death behavior.

These controls MUST NOT weaken protocol or gateway validation. The SDK documentation MUST distinguish tested recipes from portable requirements and MUST NOT describe an optional hook as sufficient authorization unless the host policy establishes that fact.

## Security non-goals

V2 does not claim that a plain Node child process denies filesystem, network, or syscalls after worker compromise. It does not sandbox trusted hooks or handlers, protect against absent or over-permissive host policy, hide source from the worker, make action effects reversible, or provide durable recovery.

The protocol is specified for a host-managed local worker. Remote services, network authentication and encryption, multi-tenant worker pools, managed daemons, workflow semantics, approvals, automatic retries, compensation, audit persistence, and arbitrary JavaScript/package execution are outside protocol 1.0.
