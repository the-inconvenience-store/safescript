# Artifacts and inspection

TypeScript source is the canonical SafeScript program. Artifacts, summaries, semantic graphs, and authoring bundles are derived products with different purposes and trust rules.

## Checked artifacts

An accepted check does not serialize an artifact by default. Set `includeArtifact: true` on `check` or `inspect` when the host needs canonical artifact bytes. For source execution, the same option includes bytes in source preparation facts. The artifact binds the compiled program to:

- exact compiler build;
- contract ID, registry digest, and referenced definition fingerprints;
- slot ID;
- source-program hash and verified IR digest.

Artifacts are suitable for an optional host cache or store. Before every artifact execution, the engine treats the bytes as untrusted and revalidates canonical representation, compiler and contract binding, referenced definitions, digest integrity, and typed IR. Any mismatch fails before interpretation.

Artifact reuse never reuses a host policy decision. Actions still pass through the SDK gateway and the hooks and handlers configured for that invocation. Hosts should retain source as the canonical review and editing form and regenerate artifacts when the compiler or contract changes.

Ordinary source checks and executions use the bounded, bridge-local verified-compilation cache. That trusted internal value is not a public handle or serialization format. It remains in memory only for the bridge or worker lifetime. Serialized artifacts are a separate optional projection for hosts that deliberately provide storage or transport.

## Program summaries

Accepted checks report the statically reachable effect and capability IDs. A summary helps review, indexing, or host policy preflight, but does not prove that an action will run and does not grant runtime authority.

## Semantic graph

`safe.inspect({ views: ["semantic_graph"] })` returns a canonical JSON byte representation of compiler-owned source facts. The graph includes:

- stable schema/compiler/language/contract/slot/source identities;
- declaration, expression, control, input, output, constant, and action nodes;
- contains, control, data, input, and output edges;
- source locations, types, symbols, action sites, operations, effects, capabilities, constants, and operators where relevant;
- aggregate authorities and static resource counts.

Graph node IDs are derived from semantic meaning and remain stable across formatting-only changes. Source spans are navigation metadata, not identity.

The graph is disposable and read-only. It is not public IR, an executable node program, or an alternate source format. A visual editor may project, group, and label it, but must execute canonical TypeScript through SafeScript. The [CRM example](../examples/crm/README.md) demonstrates this pattern.

Graph export has independent node, edge, and byte limits. Accepted source can return a `viewErrors.semantic_graph` result without graph bytes. Export is atomic: consumers never receive a partial trusted graph.

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

Only operations allowed by both the slot's effects and capabilities appear in its host declarations. The bundle identifies the exact contract fingerprint and current language profile.

Authoring bundles intentionally exclude private IR, compiler passes, and semantic-graph details. They help an author produce valid source; they do not replace checking. A host should regenerate a bundle when the contract, slot, or supported language changes.

`createRegistryAuthoringBundle` supports environments that have the language-neutral registry rather than the typed SDK contract. The output remains declarations and guidance, not handlers or authority.

## Storage choices

SafeScript itself does not persist source or any derived product. A host may discard, cache, store, sign, or export them according to its needs. Consider:

- source as the canonical human-reviewable record;
- artifacts as untrusted cache entries with verification on use;
- graphs as potentially sensitive analysis data containing constants;
- traces and action facts as invocation data subject to retention and tenancy policy;
- authoring bundles as contract disclosures that should omit private host implementation details.

See the [security model](security.md) for the authority implications and [current scope](current-scope.md) for deferred storage tooling.
