# SafeScript v2 compatibility and migration

This document defines the compatibility promise and required host migration from the v1 direct bridge to the v2 worker-backed default.

## Preserved compatibility

V2 preserves canonical schemas and values, language 1.0 and 1.1 source semantics, slot effects/capabilities, deterministic time/randomness, diagnostic ownership, semantic resource charging, semantic graphs, authoring bundles, and the six-method TypeScript facade unless a separately versioned contract says otherwise.

For the same accepted source or regenerated artifact, registry, slot, input, deterministic values, semantic limits, and scripted actions, direct and worker adapters MUST agree on check status, source diagnostics/codes/provenance, program summary, graph bytes, terminal execution status/output, ordered action facts, semantic traces, and semantic usage.

## Intentional v2 changes

The default `createSafeScript` bridge starts a supervised local worker lazily. Integrations therefore gain process startup and close lifecycle, worker packaging, spawn requirements, operational limits, handshake compatibility, and stable worker/protocol failures.

Hosts MUST deploy a supported Node runtime and permit child-process stdio, or explicitly configure another supported Node executable or the direct bridge. They MUST await or otherwise observe `close` during orderly shutdown. They MUST handle worker startup/loss as bridge failures and MUST NOT retry an interrupted invocation merely because its source is deterministic.

V2 adds protocol/supervisor failure codes without changing the meaning of v1 codes. Code that exhaustively branches on a failure union must be updated. Raw process errors and exceptions remain excluded.

V2 also adopts [optional execution and action hooks](../proposals/action-hooks.md), SDK 2.0, and action ABI 2.0. It does not preserve v1's required `authorise` callback, `resourceScope` extractor, universal policy-error variant, or rejected action-outcome tag. A `beforeAction` stop is encoded as the operation's ordinary declared `Err`; hook failures remain bounded host failures or SDK-local diagnostics.

## Checked artifacts

Checked artifacts are disposable compiler-bound optimizations, not durable compatibility or permission tokens. V1 artifact bytes need not execute under the v2 compiler/worker build. A host with canonical source rechecks and stores a new artifact; a host with only an incompatible artifact receives a not-started compatibility failure.

V2 performs no automatic artifact translation and never changes source to preserve an artifact. Artifact execution still revalidates canonical bytes, compiler, language, IR, ABI, contract requirements, definitions, slot, digest, and private IR before interpretation. Checked v1 artifacts retain their ABI 1.0 requirement and run only through a compatible v1 adapter.

### Artifact regeneration procedure

Treat regeneration as a deployment migration, not an in-place byte conversion:

1. retain the canonical source and the exact v2 contract used by the target deployment;
2. create the v2 facade, call `check` for the intended slot, and require `status: "accepted"`;
3. store the returned artifact with its compiler provenance, language/IR/ABI versions, contract fingerprint, slot, and source identity;
4. exercise the artifact through the worker path with representative deterministic tests before serving it;
5. publish it in a cache namespace separate from v1 artifacts, then switch traffic atomically;
6. retain source—not cross-version artifact bytes—as the rollback authority.

Do not overwrite the last deployable artifact set until the new worker/package set and regenerated artifacts pass together. A rejected source is a migration failure to resolve at source or contract level; it is never repaired by editing artifact bytes.

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
7. Move any required authorization into `beforeAction`, handlers, or downstream services; exercise hooks and handlers through the worker action path and confirm no hook, credential, host context, or hook diagnostic crosses it.
8. Regenerate artifacts and authoring bundles from canonical source and the current contract.
9. Run direct/worker conformance and application integration tests on every deployment platform.
10. Integrate idempotent facade close into shutdown and bound external handler latency separately.

## Operational rollout

Before enabling the worker-backed default, preflight the exact installed SDK/worker package set on every deployment platform. Confirm the supported Node executable, child-process permission, pipe creation, read-only access to package files, non-sensitive working directory, empty worker environment, startup/handshake/close ceilings, and process CPU/memory controls. Run the application integration suite through both bridges, but deploy only the bridge selected by configuration.

Roll out by a normal canary or blue/green boundary that keeps each facade and worker lifecycle within one release set. Observe stable counts for startup failure, identity mismatch, timeout, worker loss, crash-loop suppression, close timeout, cancellation, and unknown action effect state. Logs and metrics must not add source, canonical payloads, environment values, paths, credentials, raw stderr, exceptions, or stack traces.

On shutdown, stop accepting new work, cancel only according to application policy, await active facade calls as appropriate, and await `close()`. On worker loss, fail the affected invocation without replay. Reconcile an unresolved effect using the host's idempotency/domain records before any new invocation; deterministic source does not make replay safe.

## Rollback and mixed versions

A v2 SDK and its bundled worker are one pinned release set. Replacing only one package is unsupported even when a handshake could technically succeed. An explicit override may use a different build only under its declared protocol/digest policy.

Rollback means deploying the previous coordinated SDK/worker set and rechecking canonical source for that compiler. A host MUST NOT reuse artifacts across incompatible builds or replay invocations interrupted during rollout. Blue/green deployments may run independent ABI 1.0 direct and ABI 2.0 worker instances against separately compatible contracts, hooks, and artifacts, but no live protocol connection translates or mixes them and action idempotency remains host-enforced.
