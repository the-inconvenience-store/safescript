# Worker and adapter conformance

An adapter or worker conforms to SafeScript 0.6.0 only by passing the same corpus through its public boundary. Implementation language, internal classes, subprocess library, and decoder structure are not conformance surfaces.

## Publication unit

The [manifest](../conformance/worker-protocol/manifest.json) identifies the normative documentation, [CDDL schema](worker-protocol.cddl), and [canonical and hostile fixtures](../conformance/worker-protocol/fixtures.json). The envelope `version: 1` and evidence `format: 1` fields are closed data-format markers, not separate supported product versions.

The publication contains one fixed canonical byte vector for every message kind. Hostile vectors cover framing, canonical CBOR, closed schemas, invalid UTF-8, unknown fields, missing fields, duplicate fields, and absolute limits. Implementations must reproduce canonical bytes and stable failure codes.

## Behavioral corpus

The suite exercises exact bootstrap and incompatibility reporting; every message in its valid state and direction; unknown, duplicate, late, crossed, and reused correlation; concurrent work and nested action exchanges; cancellation races; idempotent close; partial writes; stderr saturation; queue and credit exhaustion; lifecycle deadlines; worker loss at each phase; terminal facade failure; and explicit override identity failures.

Direct and process adapters run the same source, artifact, action, cancellation, diagnostic, semantic-graph, and resource-bound cases. Equal accepted inputs and semantic limits must produce equal public results and deterministic usage within the release. Process startup, queueing, wall time, and RSS observations are intentionally excluded from semantic equivalence.

## Release gates

SafeScript 0.6.0 release evidence requires:

- build, test, lint, and typecheck success;
- canonical and hostile protocol fixtures;
- direct/worker semantic equivalence;
- installed-tarball SDK, worker, CLI, and conformance smoke tests;
- Node.js 22 and 24 evidence on Linux x64/arm64, macOS x64/arm64, and Windows x64;
- dependency audit and no open critical security findings;
- pinned package, worker manifest, fixture, schema, and failure-catalog evidence.

The checked-in [release record](../conformance/evidence/release/0.6.0.json) describes the current gate.
