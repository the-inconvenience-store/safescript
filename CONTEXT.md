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
The versioned, verified SafeScript control-flow form produced from accepted source. It uses typed single-assignment values and explicit basic blocks and contains no host handles or ambient authority.
_Avoid_: Generated JavaScript, bytecode plugin

**Semantic program graph**:
A complete, deterministic set of source-level compiler facts derived from an accepted program and its host contract. It is disposable, non-executable, and never an input to checking, lowering, or execution.
_Avoid_: Editable program model, public IR

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
The terminal resolution of an action request as a completed declared result, a current-policy rejection, or a host failure with explicit effect state.
_Avoid_: Host response, success flag

**Effect state**:
The knowledge attached to a failed action that its external effect was either provably not performed or is unknown. Unknown never means safe to retry.
_Avoid_: Failure status, rollback status

**Action record**:
An ordered in-memory fact that an action was requested or later resolved with an action outcome. Resolution does not imply that the external effect succeeded.
_Avoid_: Workflow history, durable audit log

**Idempotency key**:
A deterministic token that lets the host identify a replay of the same logical action input. The host operation enforces it; a request identifier does not provide deduplication.
_Avoid_: Request ID, permission token

**Runtime bridge**:
The transport-neutral serialisable seam through which a host SDK checks, inspects, executes, cancels, and closes SafeScript runtime work. It is not a transport protocol, host SDK, or execution backend.
_Avoid_: Runtime API, IPC protocol, compiler service
