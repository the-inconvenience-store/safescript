# SafeScript YAGNI scan

Date: 2026-08-10

## Executive summary

SafeScript's irreducible core is coherent: a closed TypeScript-shaped language, SafeScript-owned checking and lowering, verified IR, bounded interpretation, and a typed host-action boundary that validates values and fails closed. The largest YAGNI risk is not in that core. It is in the number of optional product surfaces and future portability promises already made normative around it.

The highest-leverage scope challenges are:

1. the default worker process, custom bidirectional protocol, supervision, package-integrity, and multi-platform release stack;
2. semantic graph inspection and the CRM visual projection;
3. the simultaneous retention of a legacy CFG IR and the newer structured IR;
4. the broad “TypeScript 1.1” language and intrinsic surface beyond the syntax used by the only end-to-end example;
5. exact cross-adapter resource ledgers, compatibility metadata, and conformance machinery before there is a second execution implementation;
6. checked artifacts before there is an artifact cache, store, signing, or distribution product.

These are candidates for product decisions, not automatic deletion recommendations. In particular, process separation may be worth its cost for crash containment and defense in depth, and semantic inspection may be strategic if a real editor is imminent. The YAGNI question is whether those benefits are required **now**, not whether the implementations are technically sound.

## Method and limits

This scan reviewed the public documentation, package source, tests, conformance corpus, CRM example, Beads issue history, and recent Git history. Repository production TypeScript is approximately:

| Area                     | Non-test lines |
| ------------------------ | -------------: |
| `packages/contracts/src` |          4,101 |
| `packages/engine/src`    |          5,151 |
| `packages/sdk/src`       |          3,232 |
| `packages/worker/src`    |          1,133 |
| CLI                      |            401 |
| Conformance helpers      |            932 |
| CRM example              |          1,530 |

There are another 7,244 lines of `*.test.ts`. Line count is only a locator for maintenance cost; it is not evidence by itself that a feature is unnecessary. “No consumer” below means no independent consumer in this repository beyond implementation tests, self-authored conformance fixtures, documentation, or the showcase example. External usage cannot be inferred from this repository.

## Tier 1: strongest scope challenges

### 1. Default worker/process stack

**Confidence: high that this deserves an explicit keep/remove decision; medium that it should be removed.**

The original full design places a direct in-process TypeScript SDK in M1 and process-based SDKs in M4 (`docs/SafeScript.md:945-999`). It says the process model exists for Python, Go, Rust, fault separation, and shared semantics (`docs/SafeScript.md:794-825`). The current implementation instead makes a supervised local Node worker the default even though Python, Go, Rust, Java, and C# SDKs remain deferred (`docs/current-scope.md:45-51`; `docs/sdk.md:9-13`).

This is not a thin adapter. The direct implementation is wrapped by:

- 1,418 lines of protocol, framing, and handshake contracts;
- 1,133 lines in the worker package;
- 1,042 lines of process bridge and Node launcher;
- worker-specific conformance, CDDL, canonical/hostile fixtures, lifecycle documentation, packaging, digest verification, restart budgets, flow control, stderr capture, and platform evidence.

The protocol corpus covers crossed correlations, queue credits, partial writes, stderr saturation, crash loops, restart suppression, handshake incompatibilities, and override identities (`docs/conformance.md:7-15`). The release gate spans Node 22/24 and eight OS/architecture combinations (`docs/conformance.md:17-27`). This complexity is required by choosing a subprocess as the default, not by interpreting SafeScript.

The security case is narrower than the product positioning may imply. The security guide says the worker is trusted infrastructure, process separation is defense in depth, and it is not an OS sandbox (`docs/security.md:15-24`). The actual authority controls remain the closed language, verifier, interpreter, codecs, and gateway (`docs/security.md:1-4`). A direct-only SDK would lose fault separation, but it would not inherently give extension source ambient file/network/process access.

**YAGNI test:** keep this only if worker crash containment, host/engine process separation, or a near-term non-TypeScript SDK is a current requirement. Otherwise the direct bridge can be the product and the serializable `RuntimeBridge` can remain a future seam without implementing a protocol ecosystem now.

### 2. Semantic graph and visual projection

**Confidence: high.**

The full design labels the semantic graph and visual editor optional, explicitly says agents do not need the graph, and advises adding richer projections only after a real editor use case requires them (`docs/SafeScript.md:339-395`). The current product has 619 lines of graph derivation, about 160 lines of public graph contracts added with it, independent graph limits and failures, SDK/worker/CLI transport support, conformance locks, and a 272-line CRM projection.

The graph duplicates traversal and inference across both IR representations. `deriveSemanticGraph` chooses structured versus flat derivation (`packages/engine/src/semantic-graph.ts:536-552`), while `inferStructured` separately reconstructs schema information (`packages/engine/src/semantic-graph.ts:368-420`). That creates a third semantic view that must stay aligned with compiler and interpreter changes.

The only production consumer in the repository is the read-only CRM dashboard (`examples/crm/src/runtime.ts:99-128`; `examples/crm/src/graph/project.ts:223-272`). There is no general editor and checked source transformations are deferred (`docs/current-scope.md:51-54`).

**YAGNI test:** require an actual editor/inspection customer and a defined minimum query before retaining a stable all-purpose graph. Source locations, effect summaries, or a narrow action-site inspection response may meet the immediate need at much lower cost.

### 3. Two IRs, with one wrapped inside the other

**Confidence: very high.**

The compiler always emits version 1.1 structured IR inside a single empty legacy CFG block with one `structured` terminator (`packages/engine/src/compiler.ts:248-277`). The runtime then enters the legacy interpreter and immediately delegates that terminator to `interpretStructured` (`packages/engine/src/interpreter.ts:200-263`).

Despite that, `ir.ts` retains the old instruction set, basic blocks, jumps, branches, switches, action terminators, register dominance analysis, and their verifier (`packages/engine/src/ir.ts:90-145`, `packages/engine/src/ir.ts:301-713`). `interpreter.ts` retains the matching register-machine evaluator. The semantic graph also retains both flat and structured projection paths.

The combined cost is 723 lines of legacy IR, 266 lines of legacy interpreter, and dual paths in artifacts, graph inspection, action extraction, and verification. This looks like compatibility with a private intermediate representation rather than a current product need: the docs call IR private and disposable (`docs/engine.md:18-20`; `docs/artifacts-and-inspection.md:1-16`).

**YAGNI test:** choose one private IR. If old checked artifacts do not need indefinite execution compatibility—and the current docs bind artifacts to the exact compiler build—there is no demonstrated reason to accept both formats.

### 4. Broad language/intrinsic surface ahead of demonstrated programs

**Confidence: high that the surface should be re-justified feature by feature.**

The language grew from a small core into helpers, closures, recursion, higher-order callbacks, constrained generics, five loop forms, mutable locals, destructuring, optional syntax, arrays/tuples, multi-module programs, concurrent actions, and a large deterministic standard library (`docs/language.md:34-64`, `docs/language.md:79-96`). The three structured implementation files total 2,107 lines. The commits that introduced and completed this surface added roughly 3,000 lines including tests.

The only end-to-end CRM programs use `if`, `const`, comparisons, records, templates, sequential actions, and `Result` handling (`examples/crm/src/scripts/index.ts:8-109`). They do not use loops, recursion, closures, generics, multi-module imports, collection callbacks, JSON, bytes, time, randomness, or `Promise.all`. Broader examples live in the conformance corpus created to prove the features themselves.

There is also a mismatch between the breadth of the TypeScript claim and the checking architecture. The TypeScript checker is instantiated and queried, but its diagnostics are not consumed (`packages/engine/src/structured-compiler.ts:33-59`); SafeScript's lowerer and safety walk implement the accepted behavior. This makes every additional “familiar TypeScript” construct expensive to specify, verify, interpret, meter, document, and keep semantically compatible.

**YAGNI test:** start from the syntax required by real extension programs. Add loops, higher-order functions, recursion, modules, optional syntax, and intrinsic families independently when a use case cannot be expressed clearly without them. “Agents know TypeScript” supports familiar spelling; it does not require broad compatibility.

### 4a. Public trace modes that are behaviorally identical

**Resolved:** `safescript-u8a` replaced these string modes with one boolean trace selector. The text below records the pre-change evidence that led to that decision.

**Confidence: very high.**

`TraceMode` publicly promises `none | summary | semantic` (`packages/contracts/src/index.ts:2147`). The SDK validates and transports all three (`packages/sdk/src/facade.ts:199-210`; `packages/worker/src/protocol.ts:259`), and the engine guide documents the distinction (`docs/engine.md:73-77`). The engine, however, only branches on whether the value is `none`; `summary` and `semantic` both enable the same `ExecutionTrace` collector (`packages/engine/src/bridge.ts:477-496`, `packages/engine/src/bridge.ts:800-807`, `packages/engine/src/bridge.ts:866`).

This is not merely speculative—it is a false public distinction that every adapter must preserve. Collapse it to off/on unless a real consumer defines different summary and semantic records.

### 4b. Redundant retained-memory accounting

**Resolved:** `safescript-qt3` removed the duplicate retained-byte limit and usage fact. The text below records the pre-change evidence that led to that decision.

**Confidence: very high.**

The meter computes peak retained bytes from cumulative allocated bytes, which only increases (`packages/engine/src/bridge.ts:359-375`, `packages/engine/src/bridge.ts:414-427`). The resource-schedule documentation explicitly says `peakRetainedBytes` equals the high-water mark of cumulative allocated bytes (`docs/resource-schedule.md:37-40`). Nevertheless `allocatedBytes` and `retainedBytes` remain separate public limits and execution facts (`packages/contracts/src/index.ts:425-436`, `packages/contracts/src/index.ts:459-470`, `packages/contracts/src/index.ts:1945-1958`).

One knob and fact can be removed unless retained memory gains a genuinely different lifetime model.

### 4c. Compile-limit knobs that do not measure what they claim

**Confidence: high.**

`typeInstantiationWork` is computed as exactly `syntaxNodes * 2`, not TypeScript checker instantiation work (`packages/engine/src/bridge.ts:167-169`, `packages/engine/src/bridge.ts:237-244`). The public diagnostic limit defaults to 100, but a rejected check returns at most one diagnostic, or zero when the limit is zero (`packages/engine/src/bridge.ts:187-197`; `packages/contracts/src/index.ts:445-456`). Values 2 through 100 therefore have no behavioral meaning.

Resolution: remove the duplicate type-work limit and usage field. Replace the numeric diagnostic limit with the boolean `includeDiagnostics` control.

These knobs make the compiler look more precisely bounded than it is. Rename the syntax proxy honestly or remove it; make diagnostics a boolean/zero-or-one limit until multi-diagnostic compilation exists.

### 5. Exact semantic schedule and cross-adapter conformance before a second backend

**Confidence: high for the exactness, low for removing bounded metering itself.**

SafeScript should meter untrusted computation. The YAGNI candidate is the normative precision and compatibility promise around the current schedule. The implementation exposes ten compile ceilings and roughly thirteen execution/value ceilings (`packages/contracts/src/index.ts:403-470`), separately meters semantic operations, and locks exact charges such as insertion-sort comparisons and transcendental math (`docs/resource-schedule.md:11-40`). Changes are declared semantic compatibility changes (`docs/resource-schedule.md:57-62`).

The standard profile is calibrated from a highest positive reference workload of only 1,013 fuel and four host calls, then given fixed headroom ratios (`docs/resource-schedule.md:42-55`). Direct and worker adapters currently run the same compiler/interpreter implementation, so exact resource-ledger parity does not yet test independent semantics. Wasm and non-TypeScript runtimes are deferred (`docs/current-scope.md:45-58`).

**YAGNI test:** keep coarse deterministic fuel, value-size, call-depth, output, and host-call limits; defer a permanently compatible per-operation cost constitution until an independent backend or billing/portability requirement exists.

### 6. Checked artifacts before an artifact product exists

**Confidence: medium-high.**

Every successful check serializes the complete private IR into an artifact. Artifact execution re-parses it, rechecks canonical spelling, compiler identity, contract digest, every referenced definition fingerprint, slot, IR digest, and the complete IR verifier (`packages/engine/src/artifact.ts:104-181`; `docs/artifacts-and-inspection.md:5-16`). This drives contract fingerprints, compatibility failures, source/artifact preparation variants, CLI encoding, worker payloads, conformance equivalence, and tests.

The docs call artifacts a disposable optional cache optimization, but cache/storage/signing/export products are all deferred (`docs/current-scope.md:32-40`, `docs/current-scope.md:45-54`). Source execution already performs compile-and-run in one call.

**YAGNI test:** require measured compile latency plus a real cache/store consumer before stabilizing an externally supplied artifact format. An SDK-private in-memory compiled handle, or source-only execution, may be sufficient until then.

## Tier 2: strong simplification candidates

### 7. Operation, effect, and capability as three identities for each action

**Confidence: high that current behavior is duplicated; medium that the concepts should be collapsed permanently.**

Each operation has an operation ID, effect ID, and capability ID; each slot lists both allowed effects and capabilities; each action request carries all three; summaries return both sets (`packages/sdk/src/contract.ts:48-68`; `docs/security.md:40-48`).

In the implemented compiler, both summary sets are populated from exactly the same recognized action and checked together against the same operation (`packages/engine/src/structured-compiler.ts:262-293`, `packages/engine/src/structured-compiler.ts:648-660`). There is no implemented capability value, retained authority object, or independent capture analysis: “capabilities” are currently a second label on reachable operations. The CRM assigns one unique effect and capability to each operation (`examples/crm/src/actions.ts:57-65`).

The full design anticipates captured capabilities and higher-order analysis (`docs/SafeScript.md:445-484`), but the current representation does not demonstrate that distinction.

**YAGNI test:** use operation IDs as the initial permission and effect-summary unit. Add separately reusable effect categories or capability values only when a host needs one-to-many grouping or first-class retained authority.

### 8. Four lifecycle hooks

**Confidence: medium-high.**

The SDK has `beforeExecute`, `afterExecute`, `beforeAction`, and `afterAction` hooks in addition to mandatory operation handlers. The docs explicitly say SafeScript does not provide authorization and that authority may instead live in handlers or downstream services (`docs/sdk.md:108-116`; `docs/security.md:32-38`). They also require the host to compose multiple concerns inside the single callback at each point.

All four can be expressed around existing host code:

- validate before calling `execute`;
- observe the returned result after `execute`;
- wrap an operation handler before dispatch;
- observe inside the wrapped handler afterward.

The special semantic benefit is that `beforeAction` can produce a declared extension-visible `Err` without invoking the handler. A handler wrapper can produce the same declared `Result`. The hooks additionally require hook diagnostics, fixed-result rules, fault conversion, action/execution event unions, ordering tests, and worker protocol projections.

**YAGNI test:** retain hooks only if validated, centrally ordered interception is a product requirement that ordinary handler composition cannot satisfy. Otherwise provide recipes or an SDK helper outside the core facade.

### 9. Runtime-derived idempotency keys

**Confidence: high as a scope challenge.**

The runtime carries an optional seed through SDK, bridge, worker protocol, execution, and tests; requires it for marked operations; combines contract, operation, action site, sequence, and canonical input; and passes the result to the handler. Yet the docs are explicit that SafeScript does not enforce idempotency—the handler or downstream service must do so (`docs/sdk.md:108-116`; `docs/current-scope.md:30-39`).

This feature also makes stable action-site identity and source-sensitive key evolution part of the host contract. A host that actually owns deduplication may prefer its own business key, record ID, or request identity and can derive that inside the handler.

**YAGNI test:** keep request/invocation correlation, but make idempotency entirely host-owned until a real integration demonstrates that SafeScript's action-site formula is the correct cross-domain abstraction.

### 10. Multi-module source programs

**Confidence: medium-high.**

Every SDK request carries an entry module plus a complete module array. The implementation does not perform ordinary TypeScript module resolution; it parses all modules, strips imports/exports, rewrites namespace and named aliases with regular expressions, concatenates text, and compiles the result (`packages/engine/src/compiler.ts:125-181`).

The CRM and almost all reference programs use one module. There is one positive engine test for registered modules. This surface adds module IDs, import limits, program hashing, source provenance, protocol projections, and aliasing rules before a demonstrated extension needs source partitioning.

**YAGNI test:** accept one source string/module initially. Add a real module graph only when extension size or shared-library use cases justify semantics stronger than text concatenation.

### 10a. Worker feature negotiation with no features to negotiate

**Confidence: high.**

The worker hello/welcome protocol carries required features, optional features, and a negotiated intersection; worker overrides expose `requiredFeatures` (`packages/contracts/src/worker-handshake.ts:44-67`, `packages/contracts/src/worker-handshake.ts:303-361`; `packages/sdk/src/node-process-bridge.ts:36-52`, `packages/sdk/src/node-process-bridge.ts:94-109`). The default host and worker feature sets are both empty (`packages/sdk/src/process-bridge.ts:40-51`). Meanwhile the docs define one exact release contract with no downgrade or translation (`docs/worker-handshake.md:3-32`).

Exact release/build/limit validation can remain without a feature-negotiation abstraction until two conforming workers actually expose different optional features.

### 10b. Automatic worker restart policy

**Confidence: medium-high.**

The supervisor restarts for later work after loss under attempt-count, time-window, and recovery-interval policy (`packages/sdk/src/process-bridge.ts:663-708`, `packages/sdk/src/process-bridge.ts:762-781`). These controls are exposed through Node bridge options and documented as part of lifecycle semantics (`packages/sdk/src/node-process-bridge.ts:43-52`, `packages/sdk/src/node-process-bridge.ts:182-190`; `docs/worker-lifecycle.md:72-78`).

This is operational policy embedded in an otherwise transport-neutral runtime. A much smaller failure model is to mark the facade/bridge failed and require the host to recreate it. Keep automatic restart only if current deployments require transparent recovery for later invocations.

### 11. Concurrent `Promise.all` action groups

**Confidence: medium-high.**

Concurrent groups require static recognition, whole-group fuel/capacity reservation, deterministic request ordering, out-of-order host resolution handling, cancellation rules, action-record ordering, gateway concurrency, and conformance cases (`docs/language.md:66-77`; `docs/engine.md:57-71`).

No CRM automation uses it; the two multi-action examples are sequential. Positive usage is in implementation tests and self-authored conformance references. Concurrency also expands the number of ambiguous external-effect states the runtime must explain.

**YAGNI test:** ship sequential actions until a measured extension latency problem requires in-language concurrency. Hosts can expose a single batch operation when atomic domain batching is preferable.

### 12. Deterministic time, randomness, broad intrinsics, and semantic traces

**Confidence: medium; evaluate as separate features.**

The runtime implements fixed `Temporal.Now`, seeded `Math.random`, JSON parsing/stringification, byte codecs, numeric parsing, Unicode operations, a broad math surface, immutable collection methods, and four console methods (`docs/language.md:79-104`). Each requires compiler allow-listing, interpreter behavior, resource charges, declarations, invocation fields, wire schemas, failure codes, tests, and conformance ledgers.

The CRM execution supplies time and random seeds (`examples/crm/src/runtime.ts:116-122`) but none of its SafeScript sources uses them. The feature demonstrations are conformance programs. In many host domains, time and entropy are better modeled as explicit typed host operations because policy and test control remain obvious.

Trace mode also has `none`, `summary`, and `semantic`, while every started execution already returns action and resource facts (`docs/sdk.md:58-81`). This may be more observability taxonomy than current consumers require.

**YAGNI test:** identify the smallest intrinsic set from real scripts. Consider pure scalar/string/list operations first; add time, randomness, JSON, bytes, transcendental math, and semantic console traces only for named use cases.

### 12a. Two host-facing cancellation mechanisms

**Confidence: medium.**

Execution accepts an `AbortSignal`, while the six-method facade separately exposes `cancel(invocationId)` (`packages/sdk/src/types.ts:107-119`, `packages/sdk/src/types.ts:277-287`). Both converge on the same bridge cancellation path in the facade (`packages/sdk/src/facade.ts:388-397`, `packages/sdk/src/facade.ts:510-531`). The bridge still needs a cancellation message for process execution, but hosts may not need two public ways to initiate it.

**YAGNI test:** prefer `AbortSignal` unless a current host must cancel an invocation from a separate control plane using only its ID.

## Tier 3: packaging and developer-product candidates

### 13. Offline CLI

**Confidence: medium-high.**

The 401-line CLI mirrors `check`, `inspect`, `execute`, and `test`, adds a second serializable contract format, lossless JSON tags, path/stdin/stdout arbitration, and stable exit statuses (`docs/cli.md:1-42`). It cannot load real handlers or hooks; its execute mode is therefore scripted and overlaps deterministic testing (`docs/cli.md:24-33`).

There is no repository automation that depends on the CLI beyond CLI/release tests. If the product is an embeddable TypeScript SDK, a published CLI is a separate developer product and support surface.

**YAGNI test:** retain it only for a current CI/editor/air-gapped workflow. Otherwise keep an internal example script or defer a stable CLI until command-line users exist.

### 14. Public deterministic test DSL

**Confidence: medium.**

`safe.test` adds ordered scripted actions, fixed invocation/time/random/idempotency inputs, execution rejections, path-addressed mismatches, selected resource assertions, and a report format (`docs/testing.md:5-45`; `packages/sdk/src/testing.ts`). It is the fourth behavioral concern in the six-method production facade.

Hosts can already use fake handlers with ordinary test frameworks and call `execute`. The DSL is useful, but it need not be a runtime primitive or part of the same compatibility contract.

**YAGNI test:** move this to an optional testing package/helper unless users specifically need a stable cross-adapter extension-test format.

### 15. Authoring bundles beyond generated declarations

**Confidence: medium-low because agent authoring is central to the product story.**

Generated slot-scoped host declarations are likely core. The broader bundle adds a language profile, serialized limits/context, Markdown restrictions, generic examples, patterns, every diagnostic's repair recipe, frozen deterministic packaging, a registry-only variant, blind-agent fixtures, evidence JSON, and release thresholds (`docs/artifacts-and-inspection.md:38-55`; `packages/sdk/src/authoring.ts:23-44`, `packages/sdk/src/authoring.ts:162-226`; `docs/testing.md:67-85`).

No example application consumes the bundle. The README demonstrates creation, while conformance measures a repository-authored synthetic baseline. Some content also duplicates the language guide and declarations, creating drift risk.

**YAGNI test:** retain generated declarations and a concise restrictions document; defer the versioned bundle schema, pattern library, repair catalog, and usability release gate until an actual agent/editor integration consumes them.

### 16. Compatibility and failure catalogs wider than the current product

**Confidence: medium.**

Contracts expose many stable branded IDs, per-definition fingerprints, contract digests, compiler identities, artifact versions, action-site IDs, semantic-node IDs, worker identities, wire versions, failure domains/owners/fields, and a closed catalog that includes worker, artifact, graph, hook, time, randomness, and transport failures (`packages/contracts/src/index.ts:15-156`, `packages/contracts/src/index.ts:2189-2628`). The current package set is nevertheless one coordinated 0.6.0 release with no selectable compatibility versions (`docs/current-scope.md:28`, `docs/worker-protocol.md:9`).

Stable machine-readable compiler and execution errors are valuable. The YAGNI risk is making every optional subsystem's detailed taxonomy a permanent public compatibility promise before independent implementations or consumers exist.

**YAGNI test:** stabilize only errors callers must branch on now. Keep transport-, graph-, artifact-, and packaging-internal detail private until another implementation proves which distinctions are interoperable requirements.

### 17. Showcase and release machinery as repo complexity

**Confidence: high that it is separable; low that it should simply be deleted.**

The CRM example is 1,530 lines because it includes a store, ten automations, runtime integration, graph projection, dashboard markup/styles/client/server, and tests. It is useful evidence, but much of it demonstrates the optional semantic graph rather than the minimum embedding story. Conformance adds reference programs, resource ledgers, authoring fixtures, worker hostile cases, package-release verification, protocol fixtures, and platform evidence.

This does not necessarily increase shipped runtime complexity, but it increases every-change cost and can make self-authored fixtures look like market demand. A small canonical example plus targeted security tests would provide a clearer baseline; optional showcase and release suites can be isolated from the core acceptance gate.

## Cross-cutting signs of YAGNI

### Roadmap inversion

Several later or optional ideas are implemented and stabilized before their named consumers:

- process SDK infrastructure exists before non-TypeScript SDKs;
- artifacts exist before storage/cache/signing;
- semantic graph exists before a visual editor or checked edits;
- exact cross-backend resource compatibility exists before a second backend;
- portability schemas and protocol negotiation exist while the release has one coordinated version.

The current-scope page accurately lists these gaps (`docs/current-scope.md:45-58`), but then requires future work to preserve today's contracts. That turns speculative early choices into constraints on the future consumers that were supposed to validate them.

### Self-validation mistaken for demand

Many features have excellent tests and conformance references but no independent product use. Conformance proves that an implementation matches its specification; it does not prove the feature belongs in the specification. The CRM example is similarly valuable integration evidence, but it was built inside the same project and should not be counted as an external requirement.

### Optional features made cross-cutting

Artifacts, graphs, traces, hooks, idempotency, worker transport, and deterministic tests each project through contracts, SDK types, facade assembly, engine validation, protocol codecs, CLI parsing, tests, diagnostics, documentation, and release evidence. Even if each starts as “optional,” its maintenance is mandatory once it becomes part of the sole compatibility contract.

## Complexity that does not look like YAGNI

The following should not be swept into a simplification effort merely because they are substantial:

- **Closed language and no ambient authority.** Rejecting unsupported syntax and imports is the primary confinement model (`docs/security.md:1-4`, `docs/security.md:26-30`).
- **SafeScript-owned semantics and IR verification.** Never executing generated JavaScript and verifying untrusted executable representation are central security properties (`docs/engine.md:5-20`). The duplication between IRs is removable; verification itself is not.
- **Bounded execution.** Fuel, value sizes, call depth, output, and host-action ceilings are necessary for hostile programs. The candidate is excessive dimensionality and prematurely frozen exact charges, not metering.
- **Typed value validation at host effects.** Inputs and outcomes cross an untrusted boundary and must be checked (`docs/security.md:40-48`). Canonical CBOR specifically may be replaceable if process/artifact portability is removed, but fail-closed schema validation remains core.
- **Runtime action interception.** Compile-time summaries never prove current authority. Every concrete action still needs a host-controlled validated dispatch point (`docs/security.md:32-38`). Generic lifecycle hooks may be optional; the gateway is not.
- **Source as canonical form.** This is the simplest part of the architecture and provides reviewability without making IR, graphs, or artifacts authoritative (`docs/artifacts-and-inspection.md:1-3`).
- **Generated host API declarations.** Familiar typed authoring against exactly the permitted host surface is central to SafeScript's value proposition. The larger authoring-bundle product can be challenged separately.

## Suggested decision order

No implementation action is proposed here. If these candidates are reviewed, the dependencies make this order useful:

1. Decide whether the product currently requires a subprocess default or a near-term non-TypeScript SDK.
2. Decide whether a real visual/editor consumer requires a public semantic graph.
3. Choose one private IR and define whether old artifacts need compatibility.
4. Define the smallest language profile from actual extension programs.
5. Revisit artifacts, exact conformance, compatibility catalogs, and release matrices after those decisions.
6. Evaluate hooks, idempotency, concurrency, intrinsics, CLI, testing DSL, and authoring extras as independent opt-in products rather than one bundled runtime contract.

The likely minimal product is substantially smaller: TypeScript contract definitions and declarations, one source module, a narrow checked language, one private verified IR, direct bounded interpretation, sequential typed actions through validated handlers, coarse deterministic limits, and stable caller-relevant diagnostics. Everything else should have to name its current consumer.
