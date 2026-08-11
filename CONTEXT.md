# SafeScript

SafeScript is a restricted TypeScript extension language. This glossary defines the terms that distinguish its value and authority model from JavaScript and host application code.

## Language

**Canonical value**:
An immutable, language-neutral SafeScript value that conforms to a declared schema and has no JavaScript object identity.
_Avoid_: JavaScript value, object

**Branded value**:
A canonical primitive value with a nominal SafeScript type that prevents accidental substitution with its underlying primitive or another brand.
_Avoid_: Wrapper object

**Value limits**:
The maximum depth, node count, and encoded size permitted for one canonical value at a SafeScript seam.
_Avoid_: Recursion settings

**JSON value**:
A bounded recursive tagged union that safely represents data parsed from JSON when no closed target schema is known. It is canonical data, not an unchecked TypeScript value.
_Avoid_: Unknown JSON, `any`

**Contract-owned identifier**:
A stable host-declared identity for a contract type, effect, capability, operation, or extension slot. Its meaning cannot change and its name cannot be reused.
_Avoid_: Display name, array index

**Source-derived identifier**:
A reproducible semantic identity for a source declaration or action site. It is derived from canonical source meaning rather than file position or stored object identity.
_Avoid_: Source offset, sidecar ID

**Contract requirement**:
The exact fingerprinted contract definitions that a checked program depends on and that must remain compatible when it executes.
_Avoid_: Full contract snapshot

**Typed IR**:
The verified structured SafeScript program produced from accepted source. It contains closed expressions and statements, typed action boundaries, source locations, and no host handles or ambient authority.
_Avoid_: Generated JavaScript, bytecode plugin

**Semantic program graph**:
A complete, deterministic set of source-level compiler facts derived from an accepted program and its host contract. It is disposable, non-executable, and never an input to checking, lowering, or execution.
_Avoid_: Editable program model, public IR

**Semantic edit**:
A compiler-owned, preconditioned transformation of canonical SafeScript source addressed through stable semantic identity and followed by complete checking.
_Avoid_: Graph mutation, IR edit, text patch

**Semantic edit identifier**:
A bounded caller-chosen identity used only to correlate one operation within a semantic edit batch.
_Avoid_: Semantic target, document identifier

**Semantic target**:
A source-level program fact that a semantic edit addresses through its source-derived identifier.
_Avoid_: Source offset, edit handle

**Structural anchor**:
A semantic target that identifies a container or an ordered position where source constructs may be inserted, moved, or reordered.
_Avoid_: Character offset, cursor position

**Statement range**:
An ordered contiguous sequence of sibling statements within one structural container.
_Avoid_: Graph selection, arbitrary subgraph

**Source fragment**:
Category-tagged, incomplete SafeScript source intended to be parsed and checked in the lexical and type context of a semantic target.
_Avoid_: Text patch, public AST

**Semantic edit batch**:
An ordered, atomic group of semantic edits whose targets all belong to one accepted source revision.
_Avoid_: Patch series, edit transaction log

**Semantic revision**:
The reproducible identity of accepted source under its exact module, slot, contract, compiler, language, graph-schema, and edit-schema context.
_Avoid_: Document version, session revision

**Semantic precondition**:
An explicit expectation about a semantic target or its structural relationships that must remain true before an edit can be applied.
_Avoid_: Best-effort guard, merge hint

**Semantic edit coverage**:
The guarantee that every construct accepted by a SafeScript release participates in the foundational semantic-edit model.
_Avoid_: Editor support, whole-file replacement

**Edit capability manifest**:
A disposable compiler-derived description of the semantic edits applicable to targets and insertion sites in one accepted source revision.
_Avoid_: Editor configuration, permission manifest

**Semantic diff**:
A transformation-provenance account of which semantic identities were preserved, changed, removed, or added by an accepted semantic edit batch.
_Avoid_: Text diff, graph patch

**Lossless source transformation**:
A source change that preserves every byte outside its minimal transformed syntactic regions and deterministically prints only new or replaced content.
_Avoid_: Reformat, source regeneration

**Source location**:
A half-open range measured in UTF-8 bytes within one explicitly identified source module.
_Avoid_: UTF-16 range, line and column pair

**Owned comment**:
A contiguous leading or same-line trailing source comment whose movement or removal follows the construct it describes.
_Avoid_: Semantic node, free-floating trivia

**Visual projection**:
A host-defined, read-only selection and grouping of semantic program graph facts for human inspection. It carries no program meaning or authority beyond the graph and canonical TypeScript source from which it was derived.
_Avoid_: Node program, visual source

**Semantic charge**:
Deterministic resource usage assigned by the SafeScript IR and ABI specification to language operations and the canonical values they inspect or produce. It does not measure JavaScript-engine work or host latency.
_Avoid_: CPU cycle, implementation cost

**Action suspension**:
The bounded in-memory pause of one invocation after it records an action request and before it receives the matching validated outcome. It is private interpreter state, not a durable continuation.
_Avoid_: Workflow state, checkpoint

**Action request**:
The canonical fact that an invocation has proposed one typed host operation. It is neither current authorisation nor proof that the external effect occurred.
_Avoid_: Command execution, permission grant

**Action outcome**:
The terminal typed resolution of an action request as a completed declared result or a host failure with explicit effect state. A host hook that stops an action supplies the operation's declared error rather than a protocol-level policy rejection.
_Avoid_: Host response, success flag

**Action policy hook**:
The optional host-local `beforeAction` callback. It receives a validated and decoded action immediately before handler dispatch and may continue or return the operation's declared error. It never crosses the runtime bridge.
_Avoid_: Built-in authorization, worker callback, middleware registry

**Validated interception point**:
The SDK-owned boundary after public and action-envelope validation where configured host policy may run before trusted work. It guarantees safe placement and fail-closed plumbing, not that the host has authorized the request.
_Avoid_: Permission grant, policy engine

**Effect state**:
The knowledge attached to a failed action that its external effect was either provably not performed or is unknown. Unknown never means safe to retry.
_Avoid_: Failure status, rollback status

**Action record**:
An ordered in-memory fact that an action was requested or later resolved with an action outcome. Resolution does not imply that the external effect succeeded.
_Avoid_: Workflow history, durable audit log

**Idempotency key**:
A domain-specific token that lets a host identify a replay of the same logical effect. The host selects, stores, and enforces it; SafeScript request identifiers provide correlation, not deduplication.
_Avoid_: Request ID, permission token

**Runtime bridge**:
The transport-neutral serialisable seam through which a host SDK checks, inspects, executes, cancels, and closes SafeScript runtime work. It is not a transport protocol, host SDK, or execution backend.
_Avoid_: Runtime API, IPC protocol, compiler service

**Runtime worker**:
A separately supervised local process that runs the SafeScript compiler and interpreter and proposes typed host actions across the worker protocol. It holds no handlers, credentials, or current authority.
_Avoid_: Daemon, workflow worker, trusted plugin process

**Worker protocol**:
The language-neutral, bidirectional SafeScript 0.7.0 contract between a host adapter and a runtime worker. It carries runtime-bridge operations, typed action requests and outcomes, cancellation, lifecycle, and bounded execution facts without granting host authority.
_Avoid_: Runtime bridge, remote service API, permission channel
