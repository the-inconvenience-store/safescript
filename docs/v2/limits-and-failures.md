# Worker protocol limits and failures

This document defines process-boundary limits, flow control, operational facts, and stable protocol/supervisor failures. Existing [compile, execution, graph, and value limits](../limits-and-diagnostics.md) remain normative and independent.

## Limit composition

Protocol absolute ceilings, worker maxima, host deployment maxima, slot limits, and request-specific limits combine by taking the minimum for each applicable dimension. A caller may lower but never raise a ceiling. Zero, negative, fractional, out-of-range, missing required, or internally inconsistent limits fail before work; zero never means unlimited.

The handshake selects session-wide operational maxima. Per-kind and per-request schemas may lower them. Capacity MUST be checked and reserved before protected decoding, allocation, queueing, compilation, interpretation, action dispatch, or output commit.

## Protocol limits

Protocol 1.0 defines this standard local-worker profile:

| Dimension                             | Standard maximum | Absolute rule                               |
| ------------------------------------- | ---------------: | ------------------------------------------- |
| Envelope frame bytes                  |       16,777,216 | Protocol absolute maximum                   |
| Nested payload bytes                  |       16,700,000 | Must fit one envelope                       |
| Decoded item depth                    |              128 | Envelope and payload measured independently |
| Decoded item nodes                    |        1,000,000 | Count before materialising each node        |
| In-flight initiated messages per peer |               64 | Excludes reserved terminal capacity         |
| Pending terminal replies per peer     |              128 | Includes action outcomes                    |
| Queued outbound bytes per peer        |       33,554,432 | Whole frames only                           |
| Partial-frame duration                |       10 seconds | Host monotonic time; non-semantic           |
| Worker startup                        |       30 seconds | Includes process spawn, not handshake       |
| Handshake                             |        5 seconds | Starts after process spawn                  |
| Graceful close                        |        5 seconds | Followed by supervisor termination          |
| Captured stderr                       |     65,536 bytes | Ring buffer; oldest bytes discarded         |
| Restart attempts                      | 3 per 60 seconds | Further startup suppressed                  |

Durations and restart windows are operational observations, not deterministic program inputs. An implementation MAY expose lower deployment defaults but MUST report the selected values.

## Flow control

Each accepted initiating message consumes one in-flight credit until its terminal reply is emitted and accepted for writing. Each peer tracks its own outbound queued bytes and the peer-advertised inbound maxima. It MUST apply local backpressure rather than send work without capacity.

The worker reserves reply capacity before accepting host work. Before exposing a `Promise.all` action group it reserves all action-request, host-call, payload, and reply capacity for the group. The host reserves action-outcome and cancellation capacity independently so saturation cannot deadlock an active execution.

Whole-frame writes are serialized. Reads and decoding pause when bounded queues are full. Implementations schedule ready invocations fairly; no invocation may permanently starve another while repeatedly retaining and reacquiring session capacity. Conformance checks invariants and bounds, not wall-clock ordering across independent invocations.

## Semantic resources

Process separation does not change the language/IR semantic resource schedule. Fuel, allocations, allocated bytes, retained bytes, value shape, collection size, call depth, host calls, concurrent actions, trace bytes, output bytes, compile usage, and graph usage MUST match the direct bridge for the same accepted inputs and selected semantic limits.

Wall time, OS scheduling, process RSS, pipe buffers, protocol bytes, queue wait, startup, handshake, handler latency, and restart counts MUST NOT be charged as semantic fuel or inserted into deterministic execution facts. Operator CPU and memory quotas are deployment controls.

## Operational facts

The SDK MAY expose bounded supervisor events for worker spawn, handshake, readiness, request acceptance/completion, cancellation, protocol violation, exit, restart suppression, and close. Stable fields are limited to event kind, worker/package/compiler/build identity, selected protocol/features/limits, envelope correlation IDs, invocation ID when already public, exit code or signal, failure code, and exhausted dimension.

Host instrumentation may attach local timestamps and durations. They are explicitly non-normative and absent from direct/worker semantic equivalence. Source, input, output, registry contents, canonical values, frames, environment, paths, stack traces, and credentials are excluded by default.

## Protocol failure catalog

Wire codes are defined by the [wire specification](wire-protocol.md#wire-failures). Protocol 1.0 additionally owns:

| Code                       | Stable meaning                                                                   |
| -------------------------- | -------------------------------------------------------------------------------- |
| `incompatible_session`     | Handshake found no valid selected session.                                       |
| `unexpected_message`       | A message kind is invalid in the current state or direction.                     |
| `invalid_correlation`      | `reply_to`, invocation, execute, or action correlation is unknown or mismatched. |
| `duplicate_message_id`     | A sender-local envelope ID was reused.                                           |
| `message_id_exhausted`     | The sender cannot allocate another uint64 ID.                                    |
| `capacity_exceeded`        | A peer sent validly shaped work without selected capacity.                       |
| `worker_start_failed`      | The local process could not be spawned under the launch contract.                |
| `worker_start_timeout`     | Startup or handshake exceeded its active deadline.                               |
| `worker_lost`              | An established worker connection ended unexpectedly.                             |
| `worker_crash_loop`        | Restart-rate capacity is exhausted.                                              |
| `worker_close_timeout`     | Graceful close exceeded its active deadline.                                     |
| `worker_identity_mismatch` | Package version, build identity, or digest violates launch policy.               |

Codes and structured fields are normative. Rendered messages are bounded, human-facing, and non-normative. These codes extend the SafeScript failure catalog in v2; implementations MUST NOT tunnel them through an unrelated v1 meaning.

## Failure scope

Malformed framing, envelope ambiguity, message-ID reuse, unknown envelope version/kind, state-direction violations, peer capacity abuse, and untrustworthy correlation are connection scoped. The supervisor closes transport and atomically fails all affected in-flight work.

A valid correlated request whose nested payload violates its selected schema may receive one bounded `protocol.error`; the request then terminates and the connection MAY remain ready only if no state or capacity ambiguity exists. Handshake incompatibility returns one `session.incompatible` and closes normally.

Worker loss never replays work. Started executions retain validated facts already observed. Any unresolved action effect is unknown unless the host proves it was not performed. Failures terminate the smallest trustworthy scope and MUST NOT be converted to source diagnostics, typed policy/domain errors, or successful cancellation.
