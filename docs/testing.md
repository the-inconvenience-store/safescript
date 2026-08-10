# Testing and conformance

SafeScript has two complementary testing layers: the SDK's deterministic extension-test API for host applications and the repository conformance suite for runtime adapters.

## Deterministic extension tests

`safe.test` checks or verifies the requested program and executes it through the same runtime bridge as production. Instead of production hooks and handlers, it uses an ordered script of expected actions and outcomes.

```ts
const report = await safe.test({
  name: 'creates a follow-up task',
  slot: 'onEvent',
  program: { kind: 'source', source },
  input: { workspaceId: 'acme', title: 'Follow up' },
  actions: [
    {
      operation: 'createTask',
      input: { workspaceId: 'acme', title: 'Follow up' },
      outcome: { tag: 'ok', value: { id: 'task-1' } },
    },
  ],
  fixed: {
    instant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
    randomSeed: [1, 2, 3, 4],
    invocationId: ids.invocation('invocation:00000000000000000000000000000001'),
    idempotencySeed: [9, 8, 7],
  },
  expect: {
    status: 'completed',
    output: { tag: 'ok', value: null },
    effects: [ids.effect('effect:tasks.create')],
    resources: { hostCalls: 1 },
  },
});

if (!report.passed) console.error(report.mismatches);
```

The scripted host checks action order, operation, canonical input, request uniqueness, and declared outcomes. Missing, extra, duplicate, or mismatched actions become path-addressed mismatches. Production hooks and handlers are never invoked.

A scripted declared `Err` covers the extension-visible path of a production `beforeAction` stop. To test callers that handle a `beforeExecute` rejection, provide `execution: { status: "rejected", code, detail? }`. Test hook ordering, host policy, audit forwarding, and handler integration through the production SDK gateway rather than `safe.test`.

Expectations may cover status, output, effects, action facts, diagnostics, and selected resource usage. The report always contains the observed execution, making failures inspectable without rerunning. Test mismatches do not throw.

Use fixed time and randomness whenever source calls their deterministic intrinsics. Fix invocation and idempotency seeds when asserting exact action facts or keys.

## What to test in a host integration

At minimum, cover:

- the successful path for every canonical extension;
- no-action branches;
- each configured before-hook continuing and stopping without unintended handler dispatch;
- absent hooks preserving normal dispatch;
- after-hooks observing fixed outcomes without rewriting them;
- domain errors returned by handlers;
- malformed/untrusted handler output failing closed;
- host-call, fuel, output, and graph ceilings relevant to the product;
- source and artifact execution equivalence;
- deterministic time, randomness, and traces where used;
- cancellation behavior for long-running handlers;
- contract changes invalidating incompatible artifacts;
- authoring bundles compiling representative agent/user output.

The integration tests described in the [CRM example](../examples/crm/README.md) exercise these patterns through the public SDK.

## Runtime bridge conformance

`@safescript/conformance` is adapter-neutral. A runtime implementation supplies a bridge factory; the suite does not import its compiler, interpreter, gateway, or transport internals.

The current corpus covers:

- application-extension, code-mode, device-rule, and walking-skeleton reference programs;
- deterministic checks and semantic graph inspection;
- source and checked-artifact execution equivalence;
- deterministic bounded resource measurements and standard profiles;
- language rejection cases and hostile atomic boundaries;
- action capacity reservation, ordering, and no replay;
- cancellation and late completion;
- declared action errors versus host/malformed failures;
- fixed time, seeded randomness, traces, outputs, and repeatable charges;
- canonical value round trips and rejection of non-canonical bytes;
- exact SafeScript release identity and public package metadata.

The authoring conformance gate also records blind-run evidence for generated authoring bundles and checks explicit success thresholds. This makes agent usability a release property rather than an anecdotal example.

## Repository quality gates

Run all workspace checks before publishing a change:

```sh
bun run format:check
bun run test
bun run lint
bun run typecheck
bun run build
```

Fuel measurements are release-local. A schedule or standard-profile change must intentionally update the release evidence and preserve deterministic exhaustion, fail-before-work charging, hard bounds, and adapter equivalence. Exact positive totals are not a cross-release compatibility promise.
