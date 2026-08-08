# Getting started

This walkthrough defines one operation, exposes it in one extension slot, runs a SafeScript program, and handles its result. It assumes Bun and this repository checkout; the published packages have the same entry points.

## 1. Install and verify the workspace

```sh
bun install
bun run build
```

The three packages used by a host are `@safescript/contracts`, `@safescript/engine`, and `@safescript/sdk`. Most integrations import the engine only indirectly through the SDK's default direct bridge.

## 2. Define the host contract

A contract type couples a stable type ID with a closed runtime schema. The TypeScript interface is for host-side checking; the schema is the cross-runtime authority.

```ts
import { ids, resultSchema } from '@safescript/contracts';
import { defineContract, type ContractType } from '@safescript/sdk';

interface Event {
  readonly workspaceId: string;
  readonly title: string;
}

interface CreatedTask {
  readonly id: string;
}

type TaskError =
  | Readonly<{ tag: 'policy'; value: Readonly<{ code: string; detail: string }> }>
  | Readonly<{ tag: 'domain'; value: string }>;

type ExtensionResult = Readonly<{ tag: 'ok'; value: null }> | Readonly<{ tag: 'error'; value: TaskError }>;

const text = { kind: 'string', maxBytes: 256 } as const;

const eventType: ContractType<Event> = {
  id: ids.type('type:demo.event'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'workspaceId', schema: text },
      { name: 'title', schema: text },
    ],
  },
};

const taskType: ContractType<CreatedTask> = {
  id: ids.type('type:demo.task'),
  schema: { kind: 'record', fields: [{ name: 'id', schema: text }] },
};

const errorType: ContractType<TaskError> = {
  id: ids.type('type:demo.task-error'),
  schema: {
    kind: 'variant',
    variants: [
      {
        tag: 'policy',
        schema: {
          kind: 'record',
          fields: [
            { name: 'code', schema: text },
            { name: 'detail', schema: text },
          ],
        },
      },
      { tag: 'domain', schema: text },
    ],
  },
};

const outputType: ContractType<ExtensionResult> = {
  id: ids.type('type:demo.extension-result'),
  schema: resultSchema({ kind: 'unit' }, { kind: 'ref', type: errorType.id }),
};

const createEffect = ids.effect('effect:tasks.create');
const createCapability = ids.capability('capability:tasks.create');

const contract = defineContract({
  id: ids.contract('contract:demo'),
  version: { major: 1, minor: 0, patch: 0 },
  operations: {
    createTask: {
      id: ids.operation('operation:tasks.create'),
      input: eventType,
      output: taskType,
      error: errorType,
      effect: createEffect,
      capability: createCapability,
      effectCost: 1,
      idempotency: 'required',
      resourceScope: (input: Event) => ({ workspaceId: input.workspaceId }),
    },
  },
  slots: {
    onEvent: {
      id: ids.slot('slot:demo.on-event'),
      input: eventType,
      output: outputType,
      languageVersion: { major: 1, minor: 1 },
      effects: [createEffect],
      capabilities: [createCapability],
    },
  },
});
```

Operation error schemas must contain a canonical `policy` variant with a string `code`. SafeScript uses it to resume the program with a typed error after a current-policy rejection.

## 3. Create the host facade

The handler performs trusted work. The authorization callback runs for every action request immediately before that handler.

```ts
import { createSafeScript } from '@safescript/sdk';

interface InvocationContext {
  readonly allowedWorkspaces: readonly string[];
}

const safe = createSafeScript<InvocationContext, typeof contract.operations, typeof contract.slots>({
  contract,
  handlers: {
    createTask: async (input) => ({
      tag: 'ok',
      value: { id: `task-for-${input.workspaceId}` },
    }),
  },
  authorise: ({ context, resourceScope }) =>
    context.allowedWorkspaces.includes(resourceScope.workspaceId ?? '')
      ? { status: 'allowed' }
      : {
          status: 'rejected',
          error: { code: 'workspace_forbidden', detail: 'Workspace is not allowed' },
        },
});
```

The SDK requires exactly one handler for every operation. It validates action envelopes, decodes inputs, derives `resourceScope`, reauthorizes, dispatches at most once, and validates the declared outcome.

## 4. Write the extension

Source is a complete set of named modules. `host:api` and `safescript:prelude` are compiler-provided modules, not ambient packages.

```ts
import { ids } from '@safescript/contracts';

const source = {
  entryModule: ids.module('module:main'),
  modules: [
    {
      id: ids.module('module:main'),
      source: `
        import { Ok, Err, type Result } from "safescript:prelude"
        import { type Context, type DemoEvent, type DemoTaskError } from "host:api"

        export async function handle(
          event: DemoEvent,
          ctx: Context,
        ): Promise<Result<void, DemoTaskError>> {
          const result = await ctx.tasks.create(event)
          if (result.tag === "error") return Err(result.value)
          return Ok()
        }
      `,
    },
  ],
};
```

Generated type names follow contract type IDs, so `type:demo.event` becomes `DemoEvent`. Use `contract.declarations` or `createAuthoringBundle(contract, "onEvent")` as the exact declaration source rather than guessing names.

## 5. Check and execute

```ts
const checked = await safe.check({ slot: 'onEvent', source });

if (checked.status !== 'accepted') {
  console.error(checked);
  process.exitCode = 1;
} else {
  const result = await safe.execute({
    slot: 'onEvent',
    program: { kind: 'artifact', bytes: checked.artifact },
    input: { workspaceId: 'acme', title: 'Follow up' },
    context: { allowedWorkspaces: ['acme'] },
    idempotencySeed: new TextEncoder().encode('demo-run-1'),
    trace: 'summary',
  });

  console.log(result);
}

await safe.close();
```

You can execute `{ kind: "source", source }` for the compile-and-run fast path or the accepted artifact bytes. Artifact execution revalidates compatibility and integrity; it does not bypass authorization.

## Next steps

- Read the [language guide](language.md) before writing non-trivial extensions.
- Read the [SDK guide](sdk.md) for limits, deterministic inputs, cancellation, inspection, and testing.
- Run the complete interactive [CRM example](../examples/crm/README.md) with `bun run --cwd examples/crm demo`.
