# Semantic editing design

This document specifies the compiler-owned semantic edit API. Schema 1.0 contracts, strict validators, capability projection, primitive and gesture kernels, direct and process bridge execution, the typed SDK facade, and canonical worker parity are implemented. [Current scope](current-scope.md) remains authoritative until the complete coverage and release-audit gate passes.

## Outcome

SafeScript will transform one accepted canonical TypeScript `SourceProgram` through a closed, versioned algebra of semantic operations. Callers discover applicable operations from a compiler-derived capability manifest, submit an atomic edit batch against an exact semantic revision, and receive either a completely checked candidate revision or a closed rejection. The semantic graph remains derived, disposable, non-executable, and never becomes compiler input.

The first implementation is complete only when every source construct accepted by the release participates in the foundational edit model. The React Flow editor and its new domain scenario are intentionally separate follow-up work.

## Invariants

- Canonical TypeScript source remains the only editable and executable program representation.
- The base source must already pass the ordinary SafeScript checker.
- Graph nodes identify semantic targets; parent and sibling nodes provide structural anchors.
- Every request binds to the exact source, module, slot, contract, compiler, language, graph schema, and edit schema.
- A batch is atomic. No rejection returns candidate source, partial views, artifacts, or a partial semantic diff.
- Runtime authority is unchanged. Edits may introduce any operation allowed by the slot, but runtime host authorization still applies to every action request.
- The API owns no document session, persistence, layout, acceptance, undo, collaboration, or publication state.
- Identical inputs and limits produce byte-identical results within one SafeScript release.
- Public source ranges use half-open UTF-8 byte offsets.
- No edit silently repairs unrelated source or invents an identifier.
- Semantic editing guarantees the documented checked transformation, not general behavioral equivalence.

## End-to-end flow

```text
accepted SourceProgram + registry + slot
  -> private checked semantic model and lossless source index
  -> semantic graph + optional edit capability manifest
  -> host constructs an atomic edit batch
  -> recompute and verify semantic revision
  -> resolve all original targets, anchors, and preconditions
  -> validate conflicts and normalize operations
  -> apply ordered transformations to original source slices
  -> parse and check the complete final source
  -> rebuild semantic model and requested derived products
  -> return checked source + operation outcomes + provenance diff
```

The compiler resolves IDs against its private checked model. It never deserializes or mutates the public semantic graph.

## Versioning and identity

The rebuilt pre-release semantic graph starts at an explicit schema version `1.0`; no compatibility projection for the current graph is required. Semantic editing has a separate schema version `1.0`. Both use the existing language-neutral `Version` shape.

Add these branded serialisable identities:

```ts
type SemanticRevisionId = Branded<string, 'SemanticRevisionId'>;
type SemanticEditId = Branded<string, 'SemanticEditId'>;
```

`SemanticRevisionId` is a domain-separated digest of:

- source and program hashes;
- module and slot IDs;
- contract registry digest;
- compiler and language-profile identity;
- graph and semantic-edit schema versions.

Each operation has a caller-chosen bounded ASCII `SemanticEditId` unique within its request. It is correlation data only.

`SemanticNodeId` retains its formatting-insensitive guarantee. Renames, moves, replacements, or changed ancestry may produce new IDs; the semantic diff supplies exact correspondence for edits applied through this API.

## Rebuilt semantic graph

The graph must describe all accepted source constructs required for editing, not only executable IR facts. It includes semantically meaningful nodes and explicit structural containers for:

- the module, imports, import specifiers, type aliases, interfaces, functions, the handler, parameters, and return types;
- variable and destructuring declarations, binding patterns, assignments, and statement containers;
- conditional branches, loop components and bodies, switch cases, returns, breaks, and continues;
- literals, names, member and index access, arrays, objects, templates, unary and binary expressions, conditionals, calls, functions, results, and actions;
- ordered argument, parameter, member, element, declaration, statement, branch, and case containers, including empty insertion sites;
- slot input/output facts, types, symbols, operations, action sites, constants, operators, effects, and source locations.

The graph does not expose punctuation, whitespace, comments, TypeScript compiler nodes, or private IR. Ordered relationships carry deterministic child positions. Binding, reference, type, control, data, input, output, and containment relationships are explicit where applicable.

Every accepted construct must have an editable boundary even when a smaller token is not a node. Formatting-only changes preserve IDs. New language syntax cannot ship until its graph and edit coverage exists.

## Tagged inspection

Replace string view names and top-level view options with tagged per-view requests:

```ts
type InspectViewRequest =
  | Readonly<{
      kind: 'semantic_graph';
      schema: Version;
      limits: SemanticGraphLimits;
    }>
  | Readonly<{
      kind: 'semantic_edit_capabilities';
      schema: Version;
      scope: 'all' | Readonly<{ targets: readonly SemanticNodeId[] }>;
      limits: SemanticEditCapabilityLimits;
    }>;

type InspectViewResult =
  | Readonly<{ kind: InspectViewRequest['kind']; status: 'accepted'; bytes: CanonicalBytes }>
  | Readonly<{ kind: InspectViewRequest['kind']; status: 'rejected'; error: InspectViewError }>;
```

Duplicate view kinds reject the request envelope. Each requested view returns one correlated result. A low graph export limit does not by itself suppress a capability result, and capability inspection can be requested without serializing the graph.

The graph and capability manifest both carry graph schema, edit schema where relevant, compiler identity, contract digest, slot and module IDs, source and program hashes, and semantic revision ID.

## Edit capability manifest

The `semantic_edit_capabilities` view is a deterministic, disposable description of compiler-known applicability. It supports whole-program and target-filtered scopes.

Each target or insertion-site descriptor contains enough structured data for a generic editor to construct a request without reimplementing SafeScript rules:

- target ID, semantic and structural kinds, parent, ordered container, and valid anchors;
- applicable primitive and high-level operation kinds;
- materialized mandatory preconditions;
- accepted source-fragment categories and expected schemas or types;
- finite operator, branch, wrapper, result-variant, and conversion choices;
- compatible slot operation IDs and relevant input, output, and error schemas;
- binding constraints and advisory collision-free name suggestions;
- owned-comment facts and any required destructive comment policy.

The manifest does not generate UI labels, layout, arbitrary expressions, or executable behavior. Its suggestions are advisory; only edit application decides acceptance.

## Fragment model

General insertion and replacement payloads are bounded UTF-8 SafeScript fragments tagged with a closed syntactic category:

```ts
type SourceFragmentCategory =
  | 'expression'
  | 'statement'
  | 'statement_list'
  | 'declaration'
  | 'declaration_list'
  | 'type'
  | 'binding_pattern'
  | 'parameter'
  | 'argument'
  | 'object_member'
  | 'array_element'
  | 'switch_case'
  | 'import_specifier';
```

The compiler never infers a category from text. Structured operation fields are used for names, IDs, literal values, operators, schema paths, mappings, policies, and finite choices.

Targets, anchors, and preconditions resolve against the original semantic revision. Fragments bind and type-check in the complete final revision, allowing a batch to rename a symbol and insert fragments using its new name. Intermediate transformations need not type-check.

## Public edit request

The transport-neutral bridge will add a compiler-only method with no host callback. Its request and result contracts and worker protocol records are already published; the callable bridge method is added with the integration stage:

```ts
interface RuntimeBridge {
  applySemanticEdits(request: ApplySemanticEditsRequest): Promise<ApplySemanticEditsResult>;
}

interface ApplySemanticEditsRequest extends CheckRequest {
  readonly editSchema: Version;
  readonly graphSchema: Version;
  readonly baseRevision: SemanticRevisionId;
  readonly edits: readonly SemanticEdit[];
  readonly editLimits: SemanticEditLimits;
  readonly views?: readonly InspectViewRequest[];
}
```

The host-facing TypeScript facade uses slot keys and source strings while the bridge uses registry, slot IDs, canonical UTF-8 bytes, and frozen language-neutral records. The worker protocol adds matching request and result message kinds. Process and direct bridges must return identical canonical results.

There is no separate preview or fragment-check endpoint: applying a stateless candidate batch is the validation path. Completion and incremental authoring queries remain a separate future editor-service concern.

## Operation algebra

### Primitive kernel

The foundational operations are:

| Operation          | Intent                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `rename_symbol`    | Rename exactly one resolved binding and its references.                |
| `replace_target`   | Replace one editable boundary with a category-checked fragment.        |
| `insert_at_anchor` | Insert one singular or list fragment at a structural anchor.           |
| `delete_target`    | Delete one target under an explicit comment policy when required.      |
| `move_target`      | Move original source and owned comments to another valid anchor.       |
| `reorder_children` | Atomically declare the complete new order of one container's children. |

These six operations provide foundational coverage for every accepted construct.

The primitive coverage audit groups accepted syntax by its actual editable grammar boundary:

| Source family                                             | Replacement fragment                      | Structural insertion                                         | Other primitive coverage                  |
| --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| modules and declarations                                  | `declaration` / `declaration_list`        | ordered module gaps                                          | delete, move, reorder                     |
| statements, branches, and cases                           | `statement` / `switch_case`               | ordered body and case gaps                                   | delete, move, reorder                     |
| expressions, constants, actions, and return values        | `expression`                              | argument, element, initializer, increment, and template gaps | delete, move, reorder                     |
| types, parameters, and bindings                           | `type`, `parameter`, or `binding_pattern` | type-parameter and parameter gaps                            | rename, delete, move, reorder             |
| imports, object members, array elements, and type members | their singular contextual category        | ordered contextual gaps                                      | rename where bound, delete, move, reorder |

The audit runs both against a focused operation fixture and a compiler-produced graph containing source-only declarations, nested containers, actions, control flow, templates, arrays, and types. Inline reorder preserves the original separator and trivia slots; structural reorder and movement carry owned source slices.

### Control-flow gestures

- `wrap_statement_range`
- `move_statement_range`
- `unwrap_control`
- `add_branch`
- `remove_branch`
- `convert_control`

Multi-statement inputs are contiguous sibling ranges in one container. Unwrap identifies the retained body or branch. Conversions exist only for explicitly defined pairs and never invent missing conditions, initializers, increments, or branches.

### Binding and extraction gestures

- `extract_local`
- `inline_local`
- `extract_function`
- `inline_function_call`
- `change_binding_pattern`
- `change_binding_mutability`

Names and reference, binding, parameter, result, capture, and declaration-removal mappings are explicit. Compiler-derived captures and outputs appear as preconditions. Inlining identifies exact reference or call targets and never silently expands every occurrence.

### Host-action gestures

- `change_action_operation`
- `set_action_input_field`
- `remove_action_input_field`
- `bind_action_result`
- `add_action_result_branch`

Operation changes use explicit compatible field mappings and fragments for unmatched required inputs. Field edits use schema paths. Field removal is offered only where the schema permits it. Result handling uses declared success and error schemas. Edit acceptance grants no runtime authority.

### Expression gestures

- `set_literal_value`
- `change_operator`
- `change_member_name`
- `toggle_optional_access`
- `change_call_callee`
- `change_object_field_name`
- `change_result_variant`

These operations carry structured values or finite choices, require expected-old-value preconditions, and preserve unaffected child expressions.

High-level operations may touch multiple declared source regions but may not perform undeclared repairs. Missing imports, return repairs, identifier creation, type coercion, dead-code removal, or result handling require explicit companion operations unless they are defined parts of the selected gesture.

The engine lowers every accepted gesture into the same atomic six-primitive transformation plan. Cross-container statement-range movement copies and removes the complete declared range in one plan. Function extraction validates the caller's capture and output symbols against graph reference edges, preserves an available declared capture type, renames captured references exactly as mapped, and materializes mapped outputs at the call site. Operation changes preserve only explicitly mapped input fields and caller-supplied required inputs.

Gesture normalization is not a repair pass. If the selected node shape, range, retained container, mapping, schema path, or declaration anchor cannot realize the requested gesture, the request is rejected without source. The final transformed program is checked through the same candidate-validation seam as primitive edits.

## Capability manifests

Capability inspection is available for the complete graph or an explicit target set and has independent target, capability, and canonical-byte limits. Each target record advertises only operations applicable to its current structural shape. Each operation carries its mandatory target preconditions and only the inputs relevant to that operation: compatible anchors and fragment categories, finite operator/control/branch/result/mutability choices, allowed host operations, schema paths and expected schemas, materialized bindings, comment ownership, and collision-free suggested names.

Capabilities are disposable facts for one exact semantic revision. The edit kernel evaluates every echoed precondition before gesture normalization; a stale old value, parent, type digest, binding set, operation, comment state, or chosen anchor rejects the whole request. A manifest grants neither compile permission nor runtime capability, and the compiler still rebuilds its private checked model before applying an edit.

## Preconditions and conflicts

Every operation changing existing meaning or placement carries materialized semantic expectations. Depending on the operation these include target kind, old name or value, schema/type, operator, operation ID, input field, parent, siblings, anchor, branch kind, condition identity, binding set, capture set, and owned-comment state.

The compiler resolves all target and anchor IDs before applying transformations. It then evaluates a versioned conflict matrix:

- disjoint edits compose;
- symbol rename may compose with compatible movement or wrapping;
- two meaning-changing edits to the same target conflict;
- deletion or replacement conflicts with edits to descendants;
- ancestor and descendant structural edits conflict unless one high-level operation defines them;
- ambiguous competing moves, reorders, or insertions conflict;
- every conflict identifies both caller edit IDs and all relevant semantic targets.

Request order is deterministic transformation order, not an overwrite rule. A node created by one operation cannot be targeted until the returned revision is accepted and reinspected.

## Lossless source transformation

The private editable source document indexes the pinned TypeScript AST and checker facts against original UTF-8 bytes. It also indexes tokens, comments, blank-line separation, indentation, newline convention, source ranges, semantic IDs, containers, and binding/reference relationships.

Transformation rules are:

- bytes outside the minimal changed regions remain identical;
- moved constructs reuse their original byte slices;
- contiguous leading and same-line trailing comments are owned by a construct;
- comments separated by a blank line belong to the container gap;
- moves carry owned comments;
- replacements retain surrounding and owned comments by default;
- deleting a commented construct requires `delete_owned_comments` or `preserve_owned_comments`;
- preserved comments rehome to the next sibling, previous sibling, or container boundary in that order;
- new or replaced syntax uses one deterministic SafeScript local printer adapted only to destination indentation and existing newline convention;
- the engine never reformats the complete module implicitly.

The rewriter records original, generated, copied, moved, and removed ranges as transformation provenance. The final source is reparsed and checked by the ordinary compiler; no transformed TypeScript AST is executed directly.

## Accepted result and semantic diff

An accepted bridge result contains:

- the complete updated canonical `SourceProgram`;
- new source hash, program hash, and semantic revision ID;
- the ordinary accepted check result and diagnostics;
- one accepted outcome per caller edit ID;
- exact original and updated UTF-8 changed ranges;
- a deterministic semantic diff;
- optional artifact bytes when requested;
- one independently accepted or rejected result per requested derived view.

The diff is built from transformation provenance correlated with the rebuilt semantic model. It represents preserved identities, old-to-new updates, renames, moves, additions, removals, originating edit IDs, and one-to-many or many-to-one relationships. It is not a text diff, graph patch, executable edit, or undo program.

Hosts implement undo by retaining prior complete source revisions.

## Rejections and diagnostics

The closed rejection reasons are:

```ts
type SemanticEditRejectionReason =
  | 'source_rejected'
  | 'stale_revision'
  | 'target_not_found'
  | 'target_kind_mismatch'
  | 'precondition_failed'
  | 'conflicting_edits'
  | 'fragment_rejected'
  | 'transformed_source_rejected'
  | 'edit_limit_exceeded';
```

Malformed envelopes and unsupported schema versions remain bridge errors. Edit rejections carry stable edit-specific codes, responsible edit IDs and targets, ordinary compiler diagnostics when applicable, and locations with explicit provenance:

```ts
type SemanticEditDiagnosticLocation =
  | { readonly kind: 'original_source'; readonly location: SourceLocation }
  | { readonly kind: 'fragment'; readonly editId: SemanticEditId; readonly start: number; readonly end: number }
  | { readonly kind: 'generated'; readonly editId: SemanticEditId; readonly target: SemanticNodeId };
```

Final-check diagnostics map backward through provenance. Synthetic wrapper offsets and unexplained offsets in an unreturned rejected candidate never cross the public seam. Cross-origin errors include related locations.

## Limits and usage

Semantic editing and capability export have independent deterministic limits which hosts and requests may only lower. The initial contract should use conservative defaults aligned with the 1 MiB source and 500,000 syntax-node compile ceilings:

```ts
interface SemanticEditLimits {
  readonly operations: number; // standard: 1,024
  readonly fragmentBytes: number; // standard: 1 MiB total
  readonly transformedRegions: number; // standard: 4,096
  readonly work: number; // standard: 2,000,000 deterministic units
  readonly provenanceEntries: number; // standard: 500,000
  readonly diffBytes: number; // standard: 4 MiB
  readonly sourceBytes: number; // standard: 1 MiB and <= compile limit
}

interface SemanticEditCapabilityLimits {
  readonly targets: number; // standard: 500,000
  readonly capabilities: number; // standard: 2,000,000
  readonly bytes: number; // standard: 8 MiB
}
```

Implementation may lower these provisional standard values when hostile tests or serialization measurements justify it, but the fields and independent accounting are required. Limit failures report the limit, maximum, and actual usage. Original and final checks report ordinary compile usage separately.

Wall-clock latency is not normative. Target resolution, projections, conflict analysis, rewriting, and provenance should be linear or `O(n log n)` in bounded input size. Benchmarks establish release-local baselines and reject material regressions. Incremental TypeScript compilation is not required for the first implementation.

## Security and authority

Semantic editing is a compiler operation and invokes no host handler or policy callback. A candidate may add any operation already allowed by the slot. Accepted results expose changed reachable operations and potential effect cost, but these remain static review facts rather than authorization.

The host decides whether to retain or publish candidate source. Execution always reparses or verifies the normal checked artifact and reauthorizes every action through the host gateway. Graphs and capability manifests can disclose types, constants, names, and contract operations and remain subject to host retention and access-control policy.

## Implementation architecture

The engine gains these private layers:

1. A UTF-16-to-UTF-8 offset index used by all public `SourceLocation` creation.
2. A checked semantic model joining TypeScript nodes and symbols, SafeScript types, contract facts, lowered controls and actions, source identities, structural containers, and ordered relationships.
3. Graph and capability projectors over that shared model.
4. A lossless editable source document with token, comment, trivia, indentation, newline, and source-slice ownership.
5. Operation validators which resolve targets and preconditions and normalize typed operations.
6. A conflict planner producing non-overlapping ordered transformations.
7. A local fragment parser/printer and source rewriter.
8. A provenance mapper joining original transformations to the final checked model.

The bounded bridge-local compilation cache may retain these private checked structures by weight. Checked artifacts do not serialize the semantic model, source index, capability manifest, or edit plan; they remain execution products and untrusted cache entries.

## Implementation sequence

Each stage keeps build, lint, typecheck, and tests green. The public feature is not declared complete until the final coverage audit.

Stages 1 through 5 are implemented: every public location uses UTF-8 byte offsets; tagged semantic graph schema 1.0 is projected from the private checked semantic model; the complete closed edit/capability contract algebra, validators, limits, diagnostics, result unions, and worker message records are published; the private rewriter owns UTF-8 indexing, comment ownership, category-bound fragment printing, conflict planning, unchanged-byte preservation, transformation provenance, limit accounting, and final-source diagnostic mapping; and the primitive resolver implements symbol rename, target replacement, anchored insertion, explicit-policy deletion, source-slice movement, and separator-preserving child reorder. No bridge currently exposes edit application—the gesture, integration, and final audit stages remain release work.

1. Convert every public source location to UTF-8 bytes and add Unicode boundary tests.
2. Build the private semantic model and replace the semantic graph contract with explicit schema `1.0`, complete source coverage, structural anchors, and tagged inspection.
3. Add edit schema, identities, operations, limits, manifests, results, diagnostics, canonical validation, and worker message contracts.
4. Implement the lossless source index, comment ownership, deterministic local printer, normalized transformation plan, conflicts, and provenance.
5. Implement and exhaustively test the six primitive operations.
6. Implement capability projection and the control, binding/extraction, action, and expression gesture families.
7. Wire direct bridge, process bridge, worker runtime, TypeScript facade, CLI inspection where applicable, and adapter-neutral conformance.
8. Migrate the CRM graph projection and every repository fixture, update public documentation and current scope, run the full language coverage audit, and establish benchmarks.

## Conformance and verification

The release gate includes:

- a coverage matrix mapping every accepted syntax construct to graph facts, structural anchors, capability descriptors, primitive edits, and tests;
- success and rejection cases for every operation, including stale revisions, missing targets, kind mismatch, failed preconditions, conflicts, invalid fragments, invalid final source, and every limit;
- comment-heavy and Unicode corpora proving ownership, diagnostic provenance, UTF-8 ranges, and byte preservation outside reported changes;
- deterministic repeated-result tests and byte-for-byte direct/process bridge parity;
- malformed protocol records, unknown schema and operation kinds, duplicate edit IDs, duplicate views, invalid canonical values, and randomized bounded batches that fail closed without leaked exceptions;
- capability-manifest cross-checks showing that advertised operations are accepted when supplied with valid payloads and unadvertised combinations reject;
- provenance assertions for preserved, updated, moved, added, removed, one-to-many, and many-to-one identity relations;
- unchanged compiler, execution, action-order, authorization, artifact-verification, and resource behavior;
- regression benchmarks over small interactive programs and source/graph/edit limit boundaries.

Required repository gates remain:

```bash
bun run build
bun run test
bun run lint
bun run typecheck
```

## Completion boundary

The semantic edit API is complete when the rebuilt graph, capability view, primitive and high-level operations, lossless transformation semantics, bridge and SDK surfaces, worker parity, full syntax coverage, conformance corpus, hostile tests, benchmarks, migrated examples, and public documentation all pass together. At that point `docs/current-scope.md` moves checked semantic source edits from deferred to implemented.

The completion boundary excludes a general visual editor, React Flow, a new example scenario, document persistence, collaboration, undo history, completion services, cross-module edits, and automated approval or execution. Those concerns begin only after this compiler API is complete.
