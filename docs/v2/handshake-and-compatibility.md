# Worker protocol handshake and compatibility

This document defines the mandatory bootstrap for worker protocol 1.0. It uses the [wire format](wire-protocol.md) and the closed payloads in the [CDDL](worker-protocol-1.0.cddl).

## Bootstrap sequence

The host is the sole handshake initiator. Its first frame MUST be `session.hello` with `reply_to: null`. Before accepting any other kind, the worker MUST return exactly one of:

- `session.welcome`, correlated to the hello, after selecting a compatible session; or
- `session.incompatible`, correlated to the hello, followed by connection close.

No compiler, interpreter, artifact, registry, source, invocation, or host action work may begin before `session.welcome`. A duplicate hello, worker-initiated hello, uncorrelated response, or pre-welcome message is a fatal state violation.

## Hello payload

`session.hello` contains:

- the host's supported protocol major and inclusive minor range;
- the SDK semantic version and build identity;
- the exact bundled-worker package version and SHA-256 build digest expected by default, or the explicitly configured override policy;
- required and optional protocol feature names, sorted and unique;
- supported ABI, language, IR, diagnostic-catalog, artifact, and authoring-bundle versions;
- operational maxima for frames, payload decoding, pending bytes, in-flight messages, partial-frame duration, startup, shutdown, captured stderr, and restart rate.

All version components are non-negative integers. Feature names use the message-kind ASCII grammar. Digests are lowercase 64-character hexadecimal strings. Lists declared as sets MUST be sorted by UTF-8 bytes and contain no duplicate.

## Selection rules

Protocol major MUST match exactly. The selected minor is the highest value contained by both inclusive minor ranges. Protocol 1.0 selects major 1, minor 0.

Selected features are the intersection of the host and worker supported sets. Every host-required feature MUST be selected. A feature is disabled unless selected; there is no implicit support inferred from a package, compiler, or protocol minor version.

For every operational maximum, the selected value is the minimum of host, worker, protocol, and applicable deployment ceilings. No negotiated value may exceed the absolute [wire limit](wire-protocol.md#reference-stdio-framing). A zero or internally inconsistent limit is incompatible rather than interpreted as unlimited.

The SDK MUST require the pinned package version and digest for its bundled worker. An explicit worker override MAY select a different build only when override configuration permits it and all protocol and per-request checks pass. Negotiation never makes an arbitrary executable trusted.

## Welcome payload

`session.welcome` contains:

- the exact selected protocol version and feature list;
- the worker package version, compiler semantic version, compiler build, and worker build digest;
- supported ABI, language, IR, diagnostic-catalog, artifact, and authoring-bundle versions;
- the selected operational limits;
- a stable worker implementation name for diagnostics, not authorization.

The host MUST validate every selected value against its hello. The worker MUST NOT select an unadvertised feature or a value above either peer's maximum. A syntactically valid but inconsistent welcome is a fatal protocol violation.

Handshake success establishes compatibility for the session protocol only. Every subsequent request still validates its ABI, language, IR, compiler, contract, artifact, slot, limits, and canonical values at the existing SafeScript seams.

## Incompatibility

`session.incompatible` contains code `incompatible_session` and a non-empty, sorted, unique list of failed dimensions. Closed dimensions are:

- `protocol_major`
- `protocol_minor`
- `required_feature`
- `bundled_worker_version`
- `worker_build_digest`
- `abi`
- `language`
- `ir`
- `diagnostic_catalog`
- `artifact`
- `authoring_bundle`
- `operational_limit`

It MAY include one bounded human-facing detail that is non-normative and MUST NOT contain peer payloads, paths, environment values, source, inputs, credentials, or stack traces. The worker sends at most one incompatibility result and then closes. Peers MUST NOT silently downgrade, retry with guessed values, launch another executable, or continue in direct mode.

## Independent version dimensions

SafeScript v2 does not reset every version to 2.0. The following remain independent:

| Dimension                  | Compatibility owner                          |
| -------------------------- | -------------------------------------------- |
| Product and TypeScript SDK | package release policy                       |
| Control envelope           | wire bootstrap specification                 |
| Worker protocol            | this handshake and selected features         |
| Language                   | language profiles                            |
| IR                         | compiler and artifact verifier               |
| ABI and bridge records     | `@safescript/contracts`                      |
| Compiler build             | compiler provenance and artifact policy      |
| Contract                   | host contract identity and semantic version  |
| Diagnostic catalog         | stable failure catalog                       |
| Authoring bundle           | authoring schema                             |
| Artifact                   | checked-artifact header and compiler binding |

Protocol negotiation does not replace existing compatibility checks and never grants authority. A selected dimension means only that both peers know how to validate that dimension's records.
