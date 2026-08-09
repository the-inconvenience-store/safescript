# Optional execution and action hooks

Status: accepted for SafeScript v2

Tracking issue: `safescript-eq6`

## Decision

Replace the TypeScript SDK's mandatory current-authorisation callback with four optional, host-controlled lifecycle hooks:

- `beforeExecute`;
- `afterExecute`;
- `beforeAction`;
- `afterAction`.

SafeScript will guarantee validation, correlation, resource bounds, and registered-handler dispatch at the action boundary. It will not claim that an invocation or action was authorised. A host may implement authorisation in a before-hook, in its handlers, in a downstream service, or in more than one layer.

Before-hooks may stop work. After-hooks may observe work but may not replace an outcome that has already been decided.

This is a breaking SDK and action-ABI change. It supersedes v2's earlier promise to preserve v1 host-contract and current-authorisation semantics. It requires SDK 2.0 and action ABI 2.0 before worker protocol 1.0 freezes; it is not a reinterpretation of v1 contracts.

## Motivation

The v1 SDK requires every host to provide `authorise`, every operation to provide a pure `resourceScope` extractor, and every operation error schema to contain a `policy` variant. The gateway invokes that callback immediately before handler dispatch. This gives SafeScript a strong guarantee that every valid action receives a current host policy decision.

The policy itself is nevertheless entirely host-owned. Many hosts already enforce authority in operation handlers or downstream services, while other hosts need admission control, quotas, tenancy checks, tracing, metrics, or maintenance gates at the same boundary. Treating one of those concerns as a mandatory SDK concept makes the contract and test API more prescriptive without making the host's policy correct.

The SDK should continue to own a safe interception point because it already owns action validation and dispatch. General lifecycle hooks retain that interception point while leaving policy composition to the host.

## Goals

- Give hosts optional interception points around a validated execution and a validated action.
- Allow a host to implement action authorisation without making authorisation an SDK abstraction.
- Keep invalid, uncorrelated, duplicate, or over-budget action requests away from hooks and handlers.
- Let a before-action hook return a declared operation error without requiring a universal policy-error shape.
- Make after-hooks useful for bounded audit forwarding, metrics, and tracing without permitting them to rewrite history.
- Preserve transport neutrality and keep hooks, host context, handlers, credentials, and policy state outside the runtime worker.
- Keep extension-visible results typed and schema-validated.

## Non-goals

- Providing RBAC, ABAC, policy evaluation, approvals, or identity management.
- Claiming that optional hooks make a handler or downstream service safe.
- Turning action records into a durable audit log.
- Allowing hooks to mutate source, checked artifacts, canonical action requests, handler inputs, or resolved outcomes.
- Providing retries, compensation, rollback, or idempotency enforcement.
- Defining a general middleware framework or dependency-injection container.

## Lifecycle

### Execution lifecycle

For a well-formed SDK execution request, the host facade:

1. validates the facade lifecycle, selected slot, invocation input, invocation identity, requested limits, deterministic inputs, cancellation signal, and structural program envelope;
2. constructs immutable execution-hook context containing host context and validated SDK facts;
3. awaits `beforeExecute`, when configured;
4. returns `not_started` with `execution_rejected` if the hook stops the execution;
5. otherwise invokes the runtime bridge;
6. fixes the bridge execution result;
7. awaits `afterExecute`, when configured;
8. attaches any bounded after-hook diagnostic without changing the fixed execution result.

At this cut line, structural program-envelope validation covers the program discriminant, source module-set shape or artifact byte container, and bounded SDK request fields. It does not establish source acceptance, artifact integrity, compatibility, or executable meaning.

`beforeExecute` therefore runs before checking or interpreting source through `execute`, and before verifying or interpreting an artifact through `execute`. Hosts that need compiler-derived facts should call `check` or `inspect` explicitly and include the relevant host decision in invocation context; an execution hook does not turn an artifact summary into authority.

`afterExecute` runs once whenever execution-hook context was constructed, whether or not `beforeExecute` itself was configured. This includes an explicit before-hook rejection, a thrown or malformed before-hook result, bridge failure, cancellation, runtime failure, and completion. Public-request validation failures that occur before hook context can be constructed invoke neither execution hook.

### Action lifecycle

When interpretation proposes an action, the host gateway:

1. validates ABI, invocation, request sequence, contract requirement, slot, operation, effect, capability, action site, source correlation, idempotency facts, and canonical input;
2. rejects an invalid, duplicate, uncorrelated, or over-budget request before invoking a hook or handler;
3. decodes the input using the registered operation schema;
4. constructs immutable action-hook context containing the validated request, decoded input, host invocation context, cancellation signal, and operation identity;
5. reserves host-call and concurrency capacity, so a stopped action still counts as an attempted action;
6. awaits `beforeAction`, when configured;
7. if stopped, validates and encodes the supplied declared operation error and does not invoke the handler;
8. otherwise invokes the one registered handler at most once and validates its result;
9. fixes the correlated action outcome and releases gateway concurrency capacity;
10. awaits `afterAction`, when configured;
11. returns the fixed outcome to the runtime and records any bounded after-hook diagnostic separately.

`afterAction` runs once whenever action-hook context was constructed and the gateway fixed a correlated outcome, whether or not `beforeAction` itself was configured. This includes an explicit stop, a thrown or malformed before-hook result, cancellation before dispatch, a completed handler result, an explicit handler failure, a handler throw, and an invalid handler result. It cannot run if no correlated outcome can be fixed, such as loss of the action transport itself.

Hooks are never invoked for an action envelope that fails gateway validation. Each configured hook is invoked at most once for a valid lifecycle event.

## Hook contracts

The public API has one optional callback at each lifecycle point. The SDK does not provide an ordered hook registry in the first version. A host that has several concerns composes them inside its callback and therefore owns their ordering.

The SDK deep-freezes each hook-context wrapper and supplies decoded canonical inputs with the existing immutable codec guarantees. Host-local invocation context remains an opaque host value: the SDK neither clones nor recursively freezes it. Hooks must treat it as readonly. Contexts contain no live runtime or service handles supplied by SafeScript, although hooks may close over host services in the same way as handlers.

Hooks may be synchronous or asynchronous and receive the invocation cancellation signal. The SDK awaits them. SafeScript does not create a wall-clock timeout around trusted host code; hosts remain responsible for bounding hook latency and external work.

### `beforeExecute`

`beforeExecute` returns either `continue` or a bounded rejection containing a stable host code of 1–64 characters and optional detail of at most 160 characters. A deliberate rejection produces a `not_started` execution result whose stable SDK failure code is `execution_rejected`. A thrown, rejected, or malformed callback produces `not_started` with `hook_fault`. Interpretation does not begin and no action can be requested in either case.

The rejection is an SDK-level result. It is not coerced into the slot output type or any operation error type.

### `afterExecute`

`afterExecute` receives the fixed public execution result plus its execution-hook context. Its return value has no semantic meaning.

### `beforeAction`

`beforeAction` returns either `continue` or `stop` with an error value from the matched operation's declared error schema. Its public TypeScript context is a discriminated union over registered operation keys and IDs, and the stop value remains correlated to the selected operation's error type. A stopped action resolves as the operation's ordinary declared `Err`; it is not a special policy outcome. The SDK validates the error before encoding it, exactly as it validates a handler result.

A malformed stop value fails closed as a gateway fault with effect state `not_performed`. The handler is not invoked.

The action context includes the decoded operation input, so a host can derive resource identifiers directly. `resourceScope` is no longer a required operation definition or SDK lifecycle step.

### `afterAction`

`afterAction` receives the fixed correlated outcome, decoded input, operation identity, request facts, host context, idempotency key when present, and cancellation signal. Its return value has no semantic meaning.

It follows the universal action-lifecycle rule above: it runs once for every correlated outcome fixed after action-hook context exists. It does not run for an action request rejected before hook context was constructed.

## Failure and cancellation semantics

- A throw, rejection, or malformed result from `beforeExecute` fails closed as `not_started` with `hook_fault`; no interpretation occurs.
- A throw, rejection, or malformed result from `beforeAction` fails closed as a gateway fault with effect state `not_performed`; the handler is not called.
- Failure of `afterAction` cannot change the action outcome, including its effect state.
- Failure of `afterExecute` cannot change the execution status or output.
- Raw exceptions, stack traces, and unbounded host details never cross the public SDK or runtime bridge.
- An after-hook failure records only an SDK-owned `hook_fault` diagnostic with lifecycle point, invocation ID, and request ID where applicable. It contains no host exception text. At most one diagnostic exists per configured after-hook invocation, so action diagnostics remain bounded by the host-call limit and execution diagnostics by one invocation.
- Cancellation is checked before and after each before-hook and before handler dispatch. After-hooks receive the cancellation signal but are still awaited once their corresponding outcome has been fixed.

An action stopped by `beforeAction` consumes one host-call attempt and the operation's semantic effect charge, just as a v1 authorization rejection does. Gateway concurrency capacity is reserved across `beforeAction` and handler dispatch and is released as soon as the outcome is fixed, before `afterAction` is awaited. Every exit path releases it exactly once.

Cancellation before handler dispatch fixes a cancelled host failure with effect state `not_performed` and then invokes `afterAction`. Cancellation cannot pre-empt trusted handler work. If cancellation occurs after dispatch, the handler receives the signal; any late handler settlement and its `afterAction` observation follow the existing late-completion rule and cannot resume or rewrite an already cancelled invocation. If a trusted callback never settles, SafeScript cannot force it to complete.

Actions in a bounded concurrent group may run hooks concurrently. No global completion order is promised across concurrent actions; correlation uses request IDs and deterministic action sequence. A host that needs serialized policy or observation must serialize inside its own callback.

SafeScript bounds recorded hook diagnostics, not the latency or external activity of trusted callbacks. An observational after-hook can still perform external work, so hosts must keep it bounded and idempotent where their application requires those properties.

## Action outcomes and ABI

The v1 `ActionOutcome` has a dedicated current-policy rejection. That tag exists to support mandatory SDK authorisation. Action ABI 2.0 removes it:

- a handler result or before-action declared error is a completed, canonically encoded operation `Result`;
- an SDK, transport, or handler infrastructure problem is a host failure with explicit effect state.

An action request remains only a proposal. An action outcome still does not prove that an external effect succeeded, and action records remain bounded in-memory execution facts rather than durable audit records.

The worker continues to treat all action requests and outcomes as untrusted protocol values. Process separation, correlation, canonical validation, replay protection, at-most-once handler dispatch, and host-only credentials remain unchanged. What changes is the claim that the host adapter necessarily performs current authorisation.

## SDK and contract changes

The v2 API removes:

- the required `authorise` facade option;
- `AuthorisationDecision` and authorization-specific action context;
- required operation `resourceScope` extractors;
- the requirement that every operation error schema contain a `policy` variant;
- the dedicated rejected action-outcome tag;
- production and scripted authorization terminology in the deterministic test API.

It adds:

- an optional `hooks` facade option with the four lifecycle callbacks;
- immutable execution- and action-hook contexts;
- a bounded `execution_rejected` result for `beforeExecute`;
- bounded SDK hook diagnostics that do not alter fixed outcomes;
- typed before-action stopping against the matched operation error schema.

Effect and capability declarations remain. They statically constrain which registered operations a slot's source may request; they do not express current host policy.

## Deterministic testing

`safe.test` does not invoke production hooks or production handlers. Its scripted action outcomes continue to stand in for the host boundary. A scripted declared `Err` covers the extension-visible behavior of an action stopped by a production before-hook; there is no authorization-specific script field.

Tests may optionally script an execution rejection to exercise callers that handle `execution_rejected`. After-hooks are host integration behavior and are tested through the SDK gateway/conformance suite rather than executed by deterministic extension tests.

Conformance must cover:

- absent hooks preserving normal execution and dispatch;
- each before-hook continuing and stopping;
- declared-error validation for stopped actions;
- before-hook throws and malformed returns failing closed;
- each after-hook observing every promised terminal path;
- after-hook failures leaving fixed outcomes unchanged;
- concurrent action correlation without an ordering claim;
- cancellation at each hook boundary;
- invalid and replayed requests invoking no hooks or handlers;
- no host context, callback, credential, or hook diagnostic crossing into the runtime worker.

## Security model

After this change, SafeScript's security claim is:

> SafeScript confines extensions to validated, bounded requests for registered host operations. The host decides whether and where to enforce user, tenant, resource, and service authority.

The SDK still provides the last validated interception point before its own handler dispatch, but configuring that point is optional. Documentation and examples must not describe a configured hook as sufficient authorization unless the example's host policy actually establishes that fact.

Downstream services should continue to enforce their own authority when they can be reached outside SafeScript or when defense in depth is required. A permissive hook, absent hook, or malicious trusted handler remains outside SafeScript's protection.

## Migration

This design is not source-compatible with the v1 host SDK or wire-compatible with action ABI 1.0. Migration requires SDK 2.0, action ABI 2.0, and the corresponding worker-protocol definitions. The v2 epic, specifications, and gateway plan therefore use optional host policy rather than preserving mandatory current authorization.

For a host that wants to preserve existing behavior:

1. move the body of `authorise` into `beforeAction`;
2. derive resource identifiers from the hook's decoded input or call a host-owned extractor;
3. return the operation's chosen declared authorization error when access is denied;
4. remove the mandatory `policy` wrapper only after extension code and error schemas have migrated;
5. update deterministic tests to script the resulting declared `Err` rather than an authorization decision.

An allow-all `authorise` callback can simply be deleted when no other hook behavior is needed.

Checked v1 artifacts retain their v1 ABI requirement and must run only against a compatible v1 adapter. They are not silently translated or reinterpreted under the hook ABI.

The old and new host behavior maps as follows:

| v1 authorization path                     | Hook-based path                                      | Extension-visible result                       |
| ----------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| allowed                                   | `beforeAction` continues                             | validated handler `Result`                     |
| rejected with policy error                | `beforeAction` stops with a declared operation error | validated declared `Err`; not a policy outcome |
| callback throws or returns malformed data | `beforeAction` throws or returns malformed data      | gateway failure, `not_performed`               |
| cancelled before handler dispatch         | cancellation before dispatch                         | cancelled host failure, `not_performed`        |
| allow-all callback                        | no `beforeAction` configured                         | validated handler `Result`                     |

This preserves the enforcement point when the host configures it, not exact v1 wire behavior and not SafeScript's former guarantee that the policy callback is present.

## Documentation impact

The normative v2 specification and worker protocol incorporate this decision. The introduction, getting started guide, SDK guide, security model, contracts and values, engine guide, artifact guidance, testing guide, current scope, glossary, and authoring guidance must distinguish historical v1 behavior from the v2 hook API before the v2 documentation gate closes.

## Alternatives considered

### Keep mandatory authorisation

This retains the strongest uniform guarantee but keeps authorization-specific policy, scope extraction, errors, and tests in the SDK. It was rejected because it makes one host concern mandatory while the policy and downstream enforcement remain host-owned.

### Authorise only around `execute`

An execution gate cannot see which branches, operations, or resources a program will reach. It is useful as `beforeExecute`, but insufficient as the only action-policy boundary.

### Put all interception inside handlers

Hosts can still do this, but the SDK owns dispatch and can provide a validated pre-dispatch point once. Removing that point would force each host to repeat ordering and fail-closed plumbing or implement a custom dispatcher.

### Expose a host-owned dispatcher

This maximizes flexibility but transfers correlation, result validation, at-most-once dispatch, and other security-sensitive gateway work to every integrator. It is a larger and less safe public surface than optional hooks.

### Provide an ordered middleware stack

This improves composition but introduces ordering, short-circuit, unwinding, and error-precedence rules. One optional callback per lifecycle point is sufficient; hosts can compose callbacks using their own application conventions.

## Acceptance record

The design was accepted with these conditions:

- the four lifecycle points and their invocation order are unambiguous;
- before-hook stop behavior is typed and fail-closed;
- after-hook failure cannot rewrite a fixed result;
- optional hooks do not weaken action-envelope validation or handler dispatch guarantees;
- the authorization guarantee is removed consistently from v1 migration and v2 design plans;
- ABI and checked-artifact compatibility consequences are explicit;
- implementation issues cover contracts, SDK, engine/bridge, tests, documentation, and v2 protocol work.
