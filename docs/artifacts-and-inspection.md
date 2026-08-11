# Artifacts and inspection

TypeScript source is the canonical SafeScript program. Artifacts, summaries, semantic graphs, and authoring bundles are derived products with different purposes and trust rules.

## Checked artifacts

An accepted check does not serialize an artifact by default. Set `includeArtifact: true` on `check` or `inspect` when the host needs canonical artifact bytes. For source execution, the same option includes bytes in source preparation facts. The artifact binds the compiled program to:

- internal format and exact compiler build;
- exact contract registry digest and slot ID;
- an opaque source-compilation key and verified IR digest;
- the compile usage needed for source-cache results;
- one verified structured program.

The current format removes the redundant contract ID, per-definition fingerprint list, separate source hash, and separate handler name. Exact registry matching replaces per-definition compatibility. The source key covers the format, compiler, language profile, registry digest, slot, canonical source identity and module order, and effective compile limits. The handler is read from the verified program.

Artifacts are suitable for an optional host cache or store. Before every artifact execution, the engine treats the bytes as untrusted and revalidates canonical representation, compiler and exact registry binding, slot and optional source-key binding, digest integrity, and typed IR. Any mismatch fails before interpretation.

Artifact reuse never reuses a host policy decision. Actions still pass through the SDK gateway, optional `beforeAction` policy, and handlers configured for that invocation. Hosts should retain source as the canonical review and editing form and regenerate artifacts when the compiler or contract changes.

Ordinary source checks and executions use the bounded, bridge-local verified-compilation cache. That trusted internal value is not a public handle or serialization format. It remains in memory only for the bridge or worker lifetime. Serialized artifacts are a separate optional projection for hosts that deliberately provide storage or transport.

## Optional host artifact storage

Configure `artifactStore` on `createSafeScript` to add read-through and write-through storage for source execution. The host implements only this interface:

```ts
interface ArtifactStore {
  load(key, { signal }): Promise<Uint8Array | readonly number[] | undefined>;
  store(key, artifact, { signal }): Promise<void>;
  remove?(key, { signal }): Promise<void>;
}
```

The key is an opaque SHA-256 value derived by SafeScript. A store must not parse artifacts or construct keys. `check` and `inspect` do not access the store; callers can still request bytes explicitly with `includeArtifact: true`.

On the first source execution for a key, the SDK loads an entry unless an accepted `check` or `inspect` has already populated the bridge-local cache. On an in-memory miss, the engine verifies any loaded bytes against the current source key, compiler, registry, slot, limits, IR digest, and complete structured-IR rules. A valid entry populates the internal cache. A miss or invalid entry compiles the source. SafeScript removes an invalid entry when `remove` exists and writes the new artifact. Later executions in the same facade use the internal cache without storage access.

Load, store, and remove calls have a 1000 ms default timeout. `artifactStoreTimeoutMs` can set a value from 1 to 60000 ms. Concurrent loads and overlapping writes for one key are single-flight. Close aborts current adapter signals. Invocation cancellation stops that invocation from waiting for a shared load; a shared operation can continue for another caller until it completes, times out, or the facade closes.

Storage is only an optimization. A load error or timeout falls back to source compilation and does not trigger a write. Store and remove errors do not change execution results. Artifact-store hit, miss, and failure states are observable to the host through its own adapter, not through language or execution facts. Artifact-only execution still has no source fallback and fails closed on invalid bytes.

### Migration from mandatory artifact output

Code that reads `checked.artifact` must add `includeArtifact: true` and handle the optional field. Code that only checks or executes source should remove artifact handling. Hosts that previously retained bytes directly can either keep explicit serialization or move the same storage behind `artifactStore`. Format-2 bytes are intentionally incompatible with the simplified format and must be regenerated from canonical source.

## Program summaries

Accepted checks report the statically reachable operation IDs. A summary helps review, indexing, or host policy preflight, but does not prove that an action will run and does not grant runtime authority.

## Semantic graph

Request graph schema 1.0 with a tagged, independently bounded view record:

```ts
views: [{ kind: 'semantic_graph', schema: { major: 1, minor: 0 }, limits: { nodes, edges, bytes } }];
```

An accepted correlated view result contains canonical JSON bytes. The graph includes:

- explicit schema, semantic-revision, compiler, language, contract, slot, module, source, and program identities;
- source-complete declarations, bindings, statements, expressions, types, containers, branches, cases, inputs, outputs, constants, and actions;
- ordered structural containers with one insertion anchor at every gap, including empty containers;
- contains, binds, references, type, control, data, input, and output relationships with stable roles and indices;
- UTF-8 source and editable boundaries, types, symbols, action sites, operations, constants, and operators where relevant;
- reachable operations and static resource counts.

Graph node IDs are derived from structural semantic paths and remain stable across formatting-only changes. Source spans are navigation metadata, not identity. The semantic revision binds the complete checked source and graph-producing context; editors must not substitute it for runtime authorisation.

The graph is disposable and read-only. It is not public IR, an executable node program, or an alternate source format. A visual editor may project, group, and label it, but must execute canonical TypeScript through SafeScript. The [CRM example](../examples/crm/README.md) demonstrates this pattern.

Graph export has independent node, edge, and byte limits. Source checking can succeed while the correlated view result is `{ kind: 'semantic_graph', status: 'rejected', error }`. Export is atomic: consumers never receive partial trusted graph bytes.

## Authoring bundles

`createAuthoringBundle(contract, slot)` creates a deterministic, frozen package for an editor or coding agent. It contains:

- slot-filtered `host:api` declarations;
- `safescript:prelude` declarations;
- deterministic global declarations;
- serialized slot context and limits;
- a short restrictions guide;
- a representative handler;
- additional supported patterns;
- stable compiler diagnostic codes with category and repair action.

Only operations in the slot's operation allow-list appear in its host declarations. The bundle identifies the exact contract fingerprint and current language profile.

Authoring bundles intentionally exclude private IR, compiler passes, and semantic-graph details. They help an author produce valid source; they do not replace checking. A host should regenerate a bundle when the contract, slot, or supported language changes.

`createRegistryAuthoringBundle` supports environments that have the language-neutral registry rather than the typed SDK contract. The output remains declarations and guidance, not handlers or authority.

## Storage choices

SafeScript itself does not provide or operate persistent storage. A host may implement `ArtifactStore` with memory, disk, a database, an object store, or a distributed cache, or may discard, sign, or export artifacts according to its needs. The host owns tenancy, namespaces, credentials, encryption, access control, retention, eviction, quotas, backup, durability, deletion, availability, and monitoring. Consider:

- source as the canonical human-reviewable record;
- artifacts as untrusted cache entries with verification on use;
- graphs as potentially sensitive analysis data containing constants;
- traces and action facts as invocation data subject to retention and tenancy policy;
- authoring bundles as contract disclosures that should omit private host implementation details.

See the [security model](security.md) for the authority implications and [current scope](current-scope.md) for deferred storage tooling.
