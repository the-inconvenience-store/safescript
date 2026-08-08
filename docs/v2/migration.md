# SafeScript v2 compatibility and migration

This document defines the compatibility promise and required host migration from the v1 direct bridge to the v2 worker-backed default.

## Preserved compatibility

V2 preserves supported v1 contract definitions, canonical schemas and values, language 1.0 and 1.1 source semantics, slot effects/capabilities, ABI action meaning, current authorization, handler signatures, deterministic time/randomness, diagnostic ownership, semantic resource charging, semantic graphs, authoring bundles, and the six-method TypeScript facade unless a separately versioned contract says otherwise.

For the same accepted source or regenerated artifact, registry, slot, input, deterministic values, semantic limits, and scripted actions, direct and worker adapters MUST agree on check status, source diagnostics/codes/provenance, program summary, graph bytes, terminal execution status/output, ordered action facts, semantic traces, and semantic usage.

## Intentional v2 changes

The default `createSafeScript` bridge starts a supervised local worker lazily. Integrations therefore gain process startup and close lifecycle, worker packaging, spawn requirements, operational limits, handshake compatibility, and stable worker/protocol failures.

Hosts MUST deploy a supported Node runtime and permit child-process stdio, or explicitly configure another supported Node executable or the direct bridge. They MUST await or otherwise observe `close` during orderly shutdown. They MUST handle worker startup/loss as bridge failures and MUST NOT retry an interrupted invocation merely because its source is deterministic.

V2 adds protocol/supervisor failure codes without changing the meaning of v1 codes. Code that exhaustively branches on a failure union must be updated. Raw process errors and exceptions remain excluded.

## Checked artifacts

Checked artifacts are disposable compiler-bound optimizations, not durable compatibility or permission tokens. V1 artifact bytes need not execute under the v2 compiler/worker build. A host with canonical source rechecks and stores a new artifact; a host with only an incompatible artifact receives a not-started compatibility failure.

V2 performs no automatic artifact translation and never changes source to preserve an artifact. Artifact execution still revalidates canonical bytes, compiler, language, IR, ABI, contract requirements, definitions, slot, digest, and private IR before interpretation, and every action receives current authorization.

## Direct bridge option

The direct in-process bridge remains an explicit conformant adapter. Hosts select it through SDK configuration for development, tests, or a deployment that consciously accepts an in-process compiler/interpreter. It is not selected automatically after missing worker files, handshake failure, crash, timeout, or unsupported platform.

Direct mode preserves semantic behavior but does not emit worker lifecycle facts and does not provide process containment. Tests that assert cross-adapter semantics should run against both factories; tests specifically about supervision run only against the process adapter.

## Host migration checklist

1. Retain canonical TypeScript source for every extension and plan artifact regeneration.
2. Upgrade the coordinated contracts, engine, worker, SDK, CLI, and conformance packages.
3. Provide a supported Node runtime and child-process permission in deployment.
4. Review the worker [spawn contract](security.md#spawn-contract) and remove inherited secrets/environment assumptions.
5. Set deployment ceilings for startup, handshake, queues, in-flight work, handler duration, close, stderr, and restart rate.
6. Handle new protocol/supervisor failure codes and unknown action effect state without generic retry.
7. Exercise authorization and handlers through the worker action path; confirm no credential or host object crosses it.
8. Regenerate artifacts and authoring bundles from canonical source and the current contract.
9. Run direct/worker conformance and application integration tests on every deployment platform.
10. Integrate idempotent facade close into shutdown and bound external handler latency separately.

## Rollback and mixed versions

A v2 SDK and its bundled worker are one pinned release set. Replacing only one package is unsupported even when a handshake could technically succeed. An explicit override may use a different build only under its declared protocol/digest policy.

Rollback means deploying the previous coordinated SDK/worker set and rechecking canonical source for that compiler. A host MUST NOT reuse artifacts across incompatible builds or replay invocations interrupted during rollout. Blue/green deployments may run independent v1 direct and v2 worker instances against the same source/contract policy, but no live protocol connection mixes them and action idempotency remains host-enforced.
