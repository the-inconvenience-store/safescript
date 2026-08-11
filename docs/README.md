# SafeScript documentation

SafeScript is an embeddable restricted TypeScript compiler and bounded runtime. It is for applications that need to run user- or agent-authored logic without giving that logic ambient access to the host process.

Start here:

- [Getting started](getting-started.md) builds a small host integration and runs an extension.
- [Introduction](introduction.md) explains what SafeScript is, what it protects, and where it fits.
- [Language guide](language.md) describes the supported TypeScript subset, its deterministic intrinsics, and its deliberate quirks.
- [SDK guide](sdk.md) covers contracts, handlers, action policy, host policy placement, execution, and testing.

Go deeper:

- [Worker protocol](worker-protocol.md), [handshake](worker-handshake.md), and [lifecycle](worker-lifecycle.md) define the process boundary.
- [Conformance](conformance.md) defines the published worker and adapter evidence.
- [Architecture and engine](engine.md) follows source through checking, typed IR, interpretation, and host actions.
- [Contracts and values](contracts-and-values.md) explains schemas, stable identities, generated declarations, and canonical encoding.
- [Security model](security.md) defines the trust boundary, validated action gateway, host authority responsibilities, failure behavior, and non-goals.
- [Artifacts and inspection](artifacts-and-inspection.md) covers checked artifacts, program summaries, semantic graphs, and authoring bundles.
- [Semantic editing](semantic-editing.md) specifies the compiler-owned graph-addressed source transformation API; [language coverage](semantic-edit-coverage.md) records its release audit.
- [Limits, diagnostics, and execution facts](limits-and-diagnostics.md) explains bounded work and stable failure reporting.
- [Testing and conformance](testing.md) covers deterministic extension tests and adapter-neutral compatibility evidence.
- [CLI](cli.md) documents the offline JSON adapter.
- [Current scope and roadmap](current-scope.md) separates what the repository implements from intentionally deferred work.
- [Semantic resource schedule](resource-schedule.md) is the normative fuel schedule.

Repository-specific contributor guidance remains in [the agent documentation](agents/domain.md). The project vocabulary is also summarized in [the root glossary](../CONTEXT.md).
