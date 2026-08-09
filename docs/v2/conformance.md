# Worker protocol conformance

An adapter or worker conforms to protocol 1.0 only by passing the same versioned corpus through its public process boundary. Implementation language, internal classes, subprocess library, and decoder structure are not conformance surfaces.

## Normative artifacts

The publication unit is identified by the [manifest](../../conformance/worker-protocol/v1/manifest.json) and contains:

- this normative document set;
- `worker-protocol-1.0.cddl`;
- canonical valid and hostile byte fixtures;
- protocol version and closed message-kind catalog;
- the selected SafeScript language, IR, action ABI 2.0, diagnostic, artifact, canonical-value, and semantic-resource references incorporated by the payload records.

Fixture schema changes use their own semantic version. Changing expected bytes, failure meaning, state transition, or semantic ledger requires the compatibility change dictated by the owning surface.

## Wire corpus

Every envelope and payload kind has at least one fixed canonical byte vector. Decoders are tested against split and coalesced frames and against hostile vectors for zero/oversize/truncated frames, non-minimal integers, indefinite items, map-key disorder, duplicate/unknown/missing fields, invalid UTF-8, forbidden tags/simple values/floats, trailing bytes, unknown versions/kinds, excessive depth/nodes/bytes, and invalid identifiers.

Encoders MUST emit the fixture bytes exactly. Decoders MUST either return the fixture's declared canonical record or the exact stable failure code and scope. Tests use known literal vectors; they do not derive expected bytes with the codec under test.

## State and lifecycle corpus

The corpus exercises successful bootstrap and all incompatibility dimensions, including ABI 1.0 versus ABI 2.0 isolation; every valid message in every state/direction; unknown, duplicate, late, crossed, and reused correlation; concurrent bridge work; nested action exchanges; cancellation races; idempotent close; partial writes; stderr saturation; queue and credit exhaustion; startup/handshake/close deadlines; worker exit at compile, interpretation, action suspension, and terminal write; restart suppression; and explicit override identity failures.

No case may replay a bridge request or action. Crash cases assert the exact facts retained and the effect state assigned to every unresolved action.

## Semantic equivalence

The existing adapter-neutral references run through direct and process bridge factories. For identical accepted inputs, both must agree exactly on:

- check/inspect status, diagnostics, repair metadata, summary, provenance, graph bytes, and compile usage;
- source and artifact execution status, output, preparation, ordered action records, trace records/truncation, and semantic execution usage;
- deterministic time/randomness, canonical values, arithmetic, loops/recursion/collections, sequential actions, and bounded action groups;
- cancellation result semantics and close idempotency.

Operational supervisor events and wall-clock durations are excluded. Any semantic difference is fixed or assigned an explicit owning version change before release.

## Security and privacy corpus

Hostile peers attempt malformed registries, artifacts, source, inputs, action requests/outcomes, oversized detail, control characters, path/environment disclosure, message replay, handler double-dispatch, credential access, stdout contamination, and unexpected exceptions.

Fixtures include distinctive secret sentinels in environment, invocation context, hook and handler closures, peer payloads, and thrown exceptions. No worker payload, stderr default, supervisor event, trace, or protocol error may reveal a forbidden sentinel. Host-local hook diagnostics may appear only on the SDK result and contain no exception text. A stopped `beforeAction` must not call a handler; malformed, duplicate, uncorrelated, or over-budget actions invoke neither hooks nor handlers.

## Platform evidence

The complete suite runs against every [supported Node/OS/architecture target](distribution-and-sdk.md#supported-platforms), using installed package artifacts rather than source-tree path shortcuts. Evidence records release version, Node version, OS, architecture, worker build digest, protocol version, fixture schema version, test command, and result.

Operational time tests assert ceilings and state invariants with platform-appropriate tolerance; they never require exact durations. Semantic byte and resource fixtures remain exact across platforms.

The repository workflow `.github/workflows/worker-conformance.yml` runs the packaged Node process adapter on the complete declared Node/OS/architecture matrix. Each successful matrix job uploads a schema-versioned JSON record under `conformance/evidence/platform/` containing the release, runtime, platform, worker digest, protocol, fixture schema, command, and result. These generated records are release evidence rather than source-controlled claims about runs that have not occurred.

## Release gates

Protocol foundation is complete when normative documents, CDDL, fixture corpus, and bounded codecs agree. The functional worker gate additionally requires every bridge method and action exchange plus direct/worker semantic equivalence. The operational gate requires supervision, flow control, limits, spawn hygiene, diagnostics, and hostile cases.

A preview may make the worker bridge default only after those three gates. Release candidate freezes protocol 1.0, public failure meanings, package layout, supported platform matrix, and migration guidance. Stable v2 requires:

- every declared platform green on the full corpus;
- no unexplained semantic divergence;
- no raw exception or secret-sentinel leakage;
- all critical security and compatibility findings closed;
- coordinated SDK, worker, fixtures, conformance metadata, and documentation publication;
- tested v1 source/contract upgrade and artifact-regeneration evidence.
