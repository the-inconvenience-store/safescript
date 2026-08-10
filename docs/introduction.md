# Introduction to SafeScript

SafeScript lets a host application accept restricted TypeScript from a user or an agent, check it against a host-owned contract, and run it with deterministic resource limits. The extension can only see the types and operations the host explicitly publishes.

SafeScript does not generate JavaScript and execute it with `eval`, Node.js, a browser realm, or a general-purpose JavaScript sandbox. Accepted source is lowered to SafeScript-owned typed intermediate representation (IR) and evaluated by a bounded interpreter.

## The problem it solves

Many products want programmable behavior: CRM automations, device rules, application hooks, or code-mode tools. Ordinary TypeScript is a poor security boundary because it assumes a large ambient environment. Even apparently simple code may reach packages, files, the network, clocks, randomness, process state, or mutable prototypes.

SafeScript changes the integration model:

1. The host defines closed data schemas, extension slots, allowed operations, and limits.
2. The compiler accepts only an explicit TypeScript subset and only registered modules.
3. The runtime interprets verified IR and meters semantic work.
4. Every host operation becomes a typed action request.
5. The SDK gateway validates that request before optional host policy and at-most-once handler dispatch.
6. The result and ordered execution facts cross back as serializable values.

The static reachable-operation summary answers “what might this program request?” It never answers “is this request allowed now?”

## The three participants

The **host developer** integrates `@safescript/sdk`. They define the contract, trusted handlers, optional `beforeAction` policy, policy placement, and limits.

The **extension author** writes restricted TypeScript against generated `host:api` declarations. They receive ordinary typed input and a `Context` containing only the operations allowed in that slot.

The **runtime** checks and executes source. It owns parsing restrictions, lowering, artifact verification, semantic metering, action request construction, cancellation, and bounded results.

## Packages in this repository

- `@safescript/contracts` contains language-neutral schemas, stable identifiers, codecs, bridge records, limits, diagnostics, and action records.
- `@safescript/engine` contains the direct in-process compiler, artifact verifier, semantic graph exporter, typed IR, and bounded interpreter.
- `@safescript/worker` packages that engine behind the bounded worker protocol.
- `@safescript/sdk` provides contract authoring and the six-method host facade, backed by a supervised local worker by default.
- `@safescript/cli` is an offline JSON adapter over the public SDK.
- `@safescript/conformance` contains adapter-neutral reference programs, resource measurements, and compatibility tests.

The current implementation is a TypeScript host SDK with a worker-backed default and an explicit conformant direct bridge. See [current scope and roadmap](current-scope.md) for the exact implemented/deferred boundary.

## What SafeScript is not

SafeScript does not persist invocations, schedule work, coordinate retries, collect approvals, or provide a workflow engine. Action records are in-memory execution facts, not a durable audit log. Artifact caching and storage are host concerns. A failed action whose effect state is `unknown` is never implicitly safe to retry.

SafeScript also does not make trusted host code safe. The `beforeAction` policy callback and operation handlers remain inside the trusted computing base and must protect credentials, validate service behavior, and enforce authority and external idempotency where required. Downstream services should retain their own checks when they are reachable outside SafeScript or defense in depth is needed.

## Where to go next

Follow [getting started](getting-started.md) for a complete integration. Extension authors should read the [language guide](language.md); platform integrators should continue with the [SDK guide](sdk.md) and [security model](security.md).
