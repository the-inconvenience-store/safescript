# Worker protocol wire format

This document defines the normative byte boundary between a SafeScript host adapter and a [runtime worker](../CONTEXT.md#runtime-worker). The [CDDL schema](worker-protocol.cddl) and [canonical fixtures](../conformance/worker-protocol/fixtures.json) are part of this specification.

## Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative requirements. Protocol implementations MUST fail closed at the smallest scope whose state remains trustworthy. They MUST NOT expose raw exceptions, stack traces, undecoded bytes, or unbounded peer-controlled text through public results.

SafeScript 0.7.0 is the sole public compatibility contract. The control-envelope `version: 1` field is an internal wire-format marker, and compiler build identities bind checked artifacts and worker packages; neither is a separately selectable product contract.

## Reference stdio framing

The reference transport is a pair of binary byte streams over child-process stdin and stdout. Stdout is reserved for protocol frames.

Each frame is:

```text
+----------------------------+---------------------------+
| 4-byte unsigned big-endian | exactly length bytes of   |
| envelope length            | deterministic CBOR        |
+----------------------------+---------------------------+
```

The absolute envelope limit is 16,777,216 bytes (16 MiB). A deployment, handshake, or message schema MAY impose a lower limit and MUST NOT raise it. The receiver MUST validate the four-byte length before allocating or decoding the envelope. Zero, a value above the active limit, EOF before the declared bytes arrive, or a partial-frame deadline breach is fatal to the connection. A receiver MUST NOT scan for a later boundary or attempt resynchronisation.

One frame contains one envelope and no trailing bytes. Writes MUST preserve whole-frame order: bytes from concurrent frames MUST NOT interleave. The transport does not provide compression, streaming payload fragments, checksums, retransmission, or replay.

## Control envelope

Envelope schema 1 is a closed map with exactly five fields:

| Field      | Type                     | Requirement                                                                     |
| ---------- | ------------------------ | ------------------------------------------------------------------------------- |
| `version`  | unsigned integer         | Exactly `1`; identifies only the control-envelope schema.                       |
| `kind`     | text                     | A published message kind from the protocol manifest.                            |
| `id`       | unsigned integer         | Sender-local value in `1..18446744073709551615`.                                |
| `reply_to` | unsigned integer or null | A previously received peer-local message ID, or null for an initiating message. |
| `payload`  | bytes                    | Exactly one separately encoded canonical CBOR payload.                          |

Each peer allocates IDs monotonically from 1 and MUST NOT reuse an ID on one connection. It MUST close before exhaustion. Direction comes from the stream endpoint and session identity comes from the connection; neither is repeated in the envelope. Invocation IDs and action request IDs are payload-domain correlation identities and MUST NOT be substituted for envelope IDs or used as deduplication keys.

`kind` MUST match `[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+`, contain at most 64 ASCII bytes, and have a permanently reserved meaning once published. Current kinds are listed in the [protocol manifest](../conformance/worker-protocol/manifest.json). Unknown kinds are never ignored.

Under deterministic map ordering the envelope keys occur as `id`, `kind`, `payload`, `version`, `reply_to`. Source-language object insertion order has no effect.

## Deterministic CBOR profile

Both the envelope and its decoded payload MUST use the deterministic profile below:

- definite-length items only;
- preferred shortest-width unsigned and negative integers;
- valid UTF-8 text containing Unicode scalar values;
- byte strings, text, arrays, closed maps, booleans, and null only unless a payload field explicitly declares `float64`;
- map keys ordered by encoded-key length and then bytewise lexical order;
- no duplicate keys, CBOR tags, `undefined`, unassigned simple values, or trailing bytes;
- declared `float64` values encoded as binary64 (`0xfb`) only, finite only, with negative zero encoded as positive zero.

A receiver MUST reject a semantically equivalent non-canonical spelling. It MAY establish canonicality with a validating decoder or decode-and-reencode comparison, provided it applies all byte, node, depth, collection, and text limits before protected work.

## Typed payloads

`payload` contains one complete deterministic-CBOR item selected by `kind`. The receiver MUST first validate the frame and envelope, then apply the selected closed payload schema independently. A payload with an unknown field, duplicate field, missing required field, unknown discriminant, wrong type, invalid canonical value, or trailing byte is invalid.

Protocol record keys are stable lowercase ASCII snake-case text. Optional fields are omitted, never represented by an invented sentinel. Closed variants use a stable text discriminant. Declared lists preserve their specified order; set-like lists additionally require the ordering and uniqueness stated by their schema.

Canonical SafeScript domain values remain opaque schema-directed CBOR byte strings in fields typed as `canonical-bytes`. They are decoded only with the declared contract schema and existing [canonical-value rules](../contracts-and-values.md). Artifacts, semantic graphs, source bytes, and traces likewise remain bounded byte strings where their existing public record says bytes.

The [CDDL](worker-protocol.cddl) defines every protocol payload. Its `bridge-*` records are the canonical wire projection of the public transport-neutral `RuntimeBridge`; they do not change bridge semantics or grant authority.

An action outcome is either a completed canonical operation `Result` or a host failure with explicit effect state; there is no protocol-level policy rejection. SDK policy callbacks, credentials, host objects, invocation context, and policy state are deliberately absent from the wire schema.

## Schema evolution

Envelope schema 1 is immutable. A future envelope that cannot be decoded by schema 1 requires a new envelope version and bootstrap rules; peers MUST NOT guess it.

Peers require exact SafeScript 0.7.0 identity. Schema changes ship with a new coordinated SafeScript release. Fields and kinds are never silently ignored, reused, or assigned a new meaning.

## Wire failures

The following wire codes have stable meanings in SafeScript 0.7.0:

| Code                           | Meaning                                                      | Scope                                                |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| `frame_length_zero`            | The declared envelope length is zero.                        | connection                                           |
| `frame_too_large`              | The declared envelope length exceeds the active ceiling.     | connection                                           |
| `truncated_frame`              | EOF occurred before the declared envelope completed.         | connection                                           |
| `frame_timeout`                | The active partial-frame deadline expired.                   | connection                                           |
| `malformed_cbor`               | Bytes are not one well-formed permitted CBOR item.           | connection                                           |
| `noncanonical_cbor`            | A well-formed item uses a forbidden alternate encoding.      | connection                                           |
| `envelope_schema`              | The envelope is not the exact closed schema.                 | connection                                           |
| `unsupported_envelope_version` | `version` is not supported.                                  | connection                                           |
| `unknown_message_kind`         | `kind` is not defined by the selected protocol.              | connection                                           |
| `payload_schema`               | The nested item violates the selected closed payload schema. | request when safely correlated; otherwise connection |
| `protocol_limit_exceeded`      | Decoding or buffering would exceed an active protocol limit. | request when safely correlated; otherwise connection |

A receiver MAY return one bounded `protocol.error` only when the envelope version, message ID, direction, and correlation are trustworthy and the state machine permits a reply. Otherwise it closes the connection. It MUST NOT continue after a connection-scoped failure.
