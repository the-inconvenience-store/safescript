# SafeScript

SafeScript is an embeddable restricted TypeScript compiler and bounded runtime. A host application defines the only types, operations, capabilities, and resource limits available to extension code; SafeScript never executes generated JavaScript or grants ambient file, network, process, package, environment, or credential access.

## Packages

- `@safescript/contracts` defines the serialisable schemas, identifiers, action ABI, runtime bridge, limits, diagnostics, and canonical codecs shared by every adapter.
- `@safescript/engine` provides the direct in-process compiler and bounded IR interpreter behind `RuntimeBridge`.
- `@safescript/sdk` provides the host-facing `defineContract` and `createSafeScript` interface, current-authorisation gateway, and deterministic test harness.
- `@safescript/conformance` hosts adapter-neutral conformance helpers.
- `apps/cli` is the initial command-line package.

## Examples

- [`examples/crm`](examples/crm) is an interactive CRM host. It shows how a contract, handlers, runtime authorisation,
  semantic-graph projection, and shared application state fit together, then lets you run the scripts in a browser.

## Development

Install dependencies with Bun, then run the same gates used for every change:

```bash
bun install
bun run format:check
bun run test
bun run lint
bun run typecheck
bun run build
```

## Integration shape

Hosts define one immutable contract and create one six-method facade:

```ts
const contract = defineContract({ id, version, types, operations, slots });
const authoringBundle = createAuthoringBundle(contract, 'onEvent');

const safe = createSafeScript({ contract, handlers, authorise });

const checked = await safe.check({ slot: 'onEvent', source });
const result = await safe.execute({
  slot: 'onEvent',
  program: { kind: 'source', source },
  input,
  context,
});
```

The versioned authoring bundle is generated from the validated registry and the slot's exact language profile. It
contains slot-scoped `host:api` declarations, prelude and deterministic-global declarations, limits, a compact
restriction guide, representative TypeScript patterns, and structured compiler-repair guidance. It never contains
private IR or semantic-graph details.

Every host operation becomes a typed action request. The SDK validates it, rechecks current authority, dispatches the registered handler at most once, validates the outcome, and returns ordered action facts with the execution result.

See [the full project design](docs/SafeScript.md) for language semantics, security boundaries, lifecycle rules, and roadmap. See [CONTEXT.md](CONTEXT.md) for the project vocabulary used in source and documentation.
