# SafeScript

SafeScript runs user- and agent-authored TypeScript inside your application without giving it access to your process. It was born from the need for a safe, restricted language that could be embedded into agentic applications for end-user-customisable workflows, extensions, and automations while remaining safe and familiar to agents and humans.

Your application defines the available data, operations, permissions, and limits. SafeScript checks source against that contract, compiles it to typed IR, and runs it in a bounded interpreter. It never executes generated JavaScript and provides no ambient file, network, package, environment, process, or credential access.

Use SafeScript for code mode, application extensions, agent-authored automations, device rules, and visual programming experiences where TypeScript remains the canonical source.

## Try it

Run the interactive CRM example:

```sh
bun install
bun run --cwd examples/crm demo
```

Open <http://localhost:4317> to inspect and execute ten CRM automations. The example includes host operations, a host-owned action hook, checked artifacts, deterministic tests, and a visual projection of the program's semantic graph.

## Use the SDK

A host defines one contract and provides one trusted handler per operation. Optional lifecycle hooks can enforce application policy or observe execution at the validated SDK boundary:

```ts
import { createAuthoringBundle, createSafeScript } from '@safescript/sdk';

const safe = createSafeScript({
  contract,
  handlers: {
    createTask: async (input) => ({
      tag: 'ok',
      value: await tasks.create(input),
    }),
  },
  hooks: {
    beforeAction: ({ context, input }) =>
      context.workspaceIds.includes(input.workspaceId)
        ? { status: 'continue' }
        : {
            status: 'stop',
            error: { tag: 'access', value: { code: 'forbidden', detail: 'Workspace access denied' } },
          },
  },
});

const authoring = createAuthoringBundle(contract, 'automation');
const checked = await safe.check({ slot: 'automation', source });

if (checked.status === 'accepted') {
  const result = await safe.execute({
    slot: 'automation',
    program: { kind: 'artifact', bytes: checked.artifact },
    input: event,
    context: { workspaceIds: [event.workspaceId] },
  });
}
```

The authoring bundle contains the slot's generated types, allowed operations, language rules, limits, examples, and compiler-repair guidance. A checked artifact is only executable input: every host action is still validated by the gateway. The host decides whether authority is enforced in a hook, handler, downstream service, or several layers.

`createSafeScript` starts a pinned, supervised local worker lazily on its first bridge operation. Hosts must run on Node.js 22 or 24 (or explicitly configure a supported Node executable) and must await `safe.close()` during shutdown. Development and constrained deployments can deliberately select the conformant in-process bridge; worker startup failure never falls back to it automatically. See the [v2 migration guide](docs/v2/migration.md) before upgrading an existing direct-mode deployment.

See [getting started](docs/getting-started.md) for a complete contract and runnable integration.

## Code mode

Give an agent a narrow host API instead of individual tool calls. It can write ordinary control flow around only the operations you expose:

```ts
import { Err, Ok, type Result } from 'safescript:prelude';
import { type Context, type ResearchRequest, type ResearchError } from 'host:api';

export async function research(request: ResearchRequest, ctx: Context): Promise<Result<void, ResearchError>> {
  const page = await ctx.http.fetch({ url: request.url });
  if (page.tag === 'error') return Err(page.value);

  for (const profileId of page.value.profileIds) {
    const enriched = await ctx.profiles.enrich({ id: profileId });
    if (enriched.tag === 'error') return Err(enriched.value);
  }

  return Ok();
}
```

The host chooses exactly what `http.fetch` and `profiles.enrich` mean, which destinations and records are allowed, and how much work one invocation may perform.

## User-authored visual editing

A visual editor can derive its canvas from the public semantic graph:

```ts
const inspected = await safe.inspect({
  slot: 'automation',
  source,
  views: ['semantic_graph'],
});

if (inspected.status === 'accepted' && inspected.views.semantic_graph) {
  const graph = JSON.parse(new TextDecoder().decode(Uint8Array.from(inspected.views.semantic_graph)));
  renderCanvas(graph);
}
```

The graph contains declarations, control flow, data flow, action sites, effects, capabilities, types, and stable semantic IDs. It is a read-only projection, not an executable node format. The editor owns how a user's visual change becomes TypeScript, then submits the new source to `safe.check` before execution.

The [CRM example](examples/crm/README.md) demonstrates this projection model.

## Agent-authored code edits

Give an agent the current source plus the exact slot-scoped authoring bundle, then check its proposal through the same compiler used in production:

```ts
const bundle = createAuthoringBundle(contract, 'automation');
const editedSource = await askYourAgent({
  source,
  files: bundle.files,
  diagnostics: bundle.diagnostics,
});

const checked = await safe.check({
  slot: 'automation',
  source: editedSource,
});

if (checked.status === 'rejected') {
  await returnDiagnosticsToAgent(checked.diagnostics);
}
```

The agent never needs private IR or compiler internals. Source remains reviewable, versionable, and canonical; artifacts and semantic graphs can always be regenerated.

## Across different verticals

The language and runtime stay the same. Each host supplies a different contract:

| Vertical         | Extension input                 | Example host operations                                         |
| ---------------- | ------------------------------- | --------------------------------------------------------------- |
| CRM and sales    | Deal, contact, or account event | Create task, assign owner, add tag, schedule follow-up          |
| Customer support | Ticket and customer context     | Classify, route, draft response, escalate                       |
| Finance          | Transaction or close event      | Flag exception, request evidence, post approved entry           |
| Internal tools   | Typed application state         | Fetch approved data, transform records, update a workspace      |
| Devices and IoT  | Telemetry snapshot              | Set actuator, emit alert, record observation                    |
| Agent code mode  | User request and tool context   | Fetch a permitted URL, enrich a profile, write a bounded result |

Operations are application-specific and dispatch only through the validated host gateway. SafeScript does not provide generic network or database access, and it does not claim that an action is authorized unless the host's own policy establishes that fact.

## What is included

- `@safescript/sdk` — contracts, host integration, validated action gateway, lifecycle hooks, authoring bundles, and deterministic tests
- `@safescript/worker` — pinned local runtime worker and versioned protocol implementation
- `@safescript/engine` — restricted TypeScript compiler, checked artifacts, semantic inspection, and bounded interpreter
- `@safescript/contracts` — serializable schemas, IDs, limits, diagnostics, canonical codecs, and runtime bridge records
- `@safescript/cli` — offline JSON commands for check, inspect, execute, and test
- `@safescript/conformance` — adapter-neutral reference programs and compatibility evidence

SafeScript is not a workflow engine, approval system, retry coordinator, durable runtime, or general JavaScript sandbox. Read [current scope](docs/current-scope.md) for the implemented and deferred boundaries.

## Documentation

- [Getting started](docs/getting-started.md)
- [Language guide](docs/language.md)
- [SDK guide](docs/sdk.md)
- [Architecture and engine](docs/engine.md)
- [Security model](docs/security.md)
- [Artifacts and semantic inspection](docs/artifacts-and-inspection.md)
- [Testing and conformance](docs/testing.md)

## Development

```sh
bun run format:check
bun run test
bun run lint
bun run typecheck
bun run build
```
