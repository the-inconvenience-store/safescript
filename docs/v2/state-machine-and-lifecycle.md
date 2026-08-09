# Worker protocol state machine and lifecycle

This document defines message ownership, correlation, connection lifecycle, cancellation, close, and worker-loss behavior for protocol 1.0.

## Roles and ownership

The **host** owns SDK invocation context, optional lifecycle hooks and policy, handlers, credentials, process supervision, and retention. The **runtime worker** owns checking, artifact verification, interpretation, semantic metering, and creation of typed action requests. Neither peer may initiate a message assigned to the other role.

| Initiator | Request kinds            | Correlated terminal kinds                   |
| --------- | ------------------------ | ------------------------------------------- |
| host      | `session.hello`          | `session.welcome` or `session.incompatible` |
| host      | `bridge.check.request`   | `bridge.check.result` or `protocol.error`   |
| host      | `bridge.inspect.request` | `bridge.inspect.result` or `protocol.error` |
| host      | `bridge.execute.request` | `bridge.execute.result` or `protocol.error` |
| host      | `bridge.cancel.request`  | `bridge.cancel.result` or `protocol.error`  |
| host      | `session.close.request`  | `session.close.result` or `protocol.error`  |
| worker    | `action.request`         | `action.outcome` or `protocol.error`        |

An initiating envelope has `reply_to: null`. A terminal envelope references exactly one received initiating message ID. Each accepted initiating message receives at most one terminal reply. Unknown, duplicate, reused, late, crossed, or directionally invalid IDs are fatal protocol violations.

## Connection states

The protocol connection has these states:

```text
new -> handshaking -> ready -> closing -> closed
  \         \          \         \
   +----------+----------+---------+-> failed
```

- **new**: no complete frame accepted; only host `session.hello` is valid.
- **handshaking**: the hello is accepted; only its terminal response is valid.
- **ready**: selected protocol operations may be initiated subject to credits and limits.
- **closing**: no new bridge work or actions may begin; active work is being cancelled and drained.
- **closed**: the close result was sent and transport reaches EOF; no further frame is valid.
- **failed**: peer state is no longer trustworthy; transport is terminated without resynchronisation.

The TypeScript facade constructs synchronously and starts its worker lazily on the first operation. Concurrent initial operations share one bounded startup and handshake. One facade owns at most one active worker connection.

## Bridge exchanges

In ready state the host may multiplex bounded `check`, `inspect`, and `execute` requests. Payloads are the canonical wire projection of the corresponding public `RuntimeBridge` request. Results preserve the existing closed result unions and do not expose exceptions or process objects.

Acceptance of a request reserves its in-flight, decode, reply, and applicable semantic capacity before protected work. A worker returns exactly one terminal result after all facts belonging to that operation are final. Message completion order may differ from initiation order; envelope correlation, not arrival position, identifies an exchange.

`check` and `inspect` never initiate actions. An `execute` result is terminal only after all of its initiated action exchanges are resolved, or after cancellation/worker failure has assigned their final observable effect states. A terminal result MUST NOT be followed by an action for that invocation.

## Action exchanges

Only the worker may initiate `action.request`, and only while interpreting one active execute request. Its payload carries the complete existing typed action request plus the parent execute envelope ID. The host validates both protocol correlation and every action-domain identity independently.

The host reserves response capacity before accepting the action and validates canonical input, registry metadata, and correlation before invoking any hook or handler. It MAY run `beforeAction`; a stop becomes a completed declared operation `Err`, while continuation or an absent hook permits at-most-once handler dispatch. After fixing the outcome, it MAY run `afterAction`, whose failure cannot change that outcome. It returns exactly one `action.outcome` containing a completed declared `Result` or host failure with explicit effect state.

Callbacks, credentials, host objects, invocation context, hook decisions, and hook diagnostics are not protocol values. The worker observes only the action request and its ABI 2.0 outcome.

An envelope ID, invocation ID, action request ID, and idempotency key are distinct. None substitutes for another. A repeated envelope or action request never dispatches a handler. The protocol never retries an action.

## Cancellation

`bridge.cancel.request` is an independently correlated, idempotent host request containing ABI version and invocation ID. Its terminal status is `accepted`, `not_active`, or `bridge_error`, matching the public bridge.

Cancellation is best effort. Once observed, the worker prevents future interpreter work and action initiation and returns a cancelled execute result with facts observed through termination. The host may ignore a late handler completion but cannot undo an external effect. An action without a validated terminal outcome is never inferred to be unperformed.

A terminal execute result and cancellation may race. Whichever state transition becomes terminal first is retained: later cancellation returns `not_active`; cancellation observed first yields a cancelled execute result. Neither path replays work.

## Graceful close

`session.close.request` has an empty payload and is idempotent at the SDK facade. On first acceptance the connection enters closing, rejects new work, signals cancellation to active invocations, and waits within the selected graceful-close deadline for terminal results and action bookkeeping.

When quiescent, the worker sends `session.close.result` with status `closed`, flushes that complete frame, closes stdout, and exits successfully. If the deadline expires, the supervisor terminates the worker and maps unfinished operations through worker-loss rules. Repeated facade `close` calls share the same terminal result. After explicit close, the supervisor MUST NOT restart.

## Worker loss and restart

Unexpected exit, signal, stdout loss, fatal protocol violation, or supervisor termination moves the connection to failed. The supervisor atomically completes every in-flight bridge operation with a bounded stable worker-loss bridge error. Started executions retain preparation, action, trace, and usage facts already validated by the host. An unresolved external action reports `effectState: unknown` unless the host can prove it was not performed.

No source request, artifact request, invocation, action, cancellation, or close operation is automatically replayed. A deterministic idempotency key does not authorize replay.

After unexpected loss, a later facade operation MAY trigger one fresh lazy worker startup and handshake for future work. Startup attempts share a bounded crash-rate budget. Exceeding it suppresses restart until the configured recovery interval or explicit facade replacement. A replacement connection starts envelope IDs from 1 and carries no protocol session state from the failed worker.
