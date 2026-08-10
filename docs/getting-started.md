# Getting started

This walkthrough defines one operation, exposes it in one extension slot, runs a SafeScript program, and handles its result. It assumes Bun and this repository checkout; the published packages have the same entry points.

## 1. Install and verify the workspace

```sh
bun install
bun run build
```

The default host integration uses `@safescript/contracts` and `@safescript/sdk`; the SDK installs the exact matching `@safescript/worker`. The worker runs under Node.js 22 or 24. A non-Node host must inject `createNodeProcessRuntimeBridge({ nodePath: '/absolute/path/to/node' })`, or explicitly choose the direct bridge shown below.

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

type TaskError = Readonly<{ code: string; detail: string }>;

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
    kind: 'record',
    fields: [
      { name: 'code', schema: text },
      { name: 'detail', schema: text },
    ],
  },
};

const outputType: ContractType<ExtensionResult> = {
  id: ids.type('type:demo.extension-result'),
  schema: resultSchema({ kind: 'unit' }, { kind: 'ref', type: errorType.id }),
};

const createTask = ids.operation('operation:tasks.create');

const contract = defineContract({
  id: ids.contract('contract:demo'),
  operations: {
    createTask: {
      id: createTask,
      input: eventType,
      output: taskType,
      error: errorType,
      effectCost: 1,
      idempotency: 'required',
    },
  },
  slots: {
    onEvent: {
      id: ids.slot('slot:demo.on-event'),
      input: eventType,
      output: outputType,
      operations: [createTask],
    },
  },
});
```

Operation errors are entirely contract-owned. There is no required policy wrapper; this example uses one record that both the host hook and handler may return as a declared error.

## 3. Create the host facade

The handler performs trusted work. This host also configures an optional `beforeAction` hook to enforce its workspace policy after the SDK has validated and decoded each action, immediately before handler dispatch.

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
  hooks: {
    beforeAction: ({ context, input }) =>
      context.allowedWorkspaces.includes(input.workspaceId)
        ? { status: 'continue' }
        : {
            status: 'stop',
            error: { code: 'workspace_forbidden', detail: 'Workspace is not allowed' },
          },
  },
});
```

Construction is synchronous and does not spawn a process. The first bridge operation starts and verifies the worker. Direct mode is an explicit deployment choice and never a fallback:

```ts
import { createDirectRuntimeBridge } from '@safescript/engine';

const directSafe = createSafeScript({
  contract,
  handlers,
  bridge: createDirectRuntimeBridge(),
});
```

Direct mode preserves language semantics but does not provide process containment. Prefer the default worker for production unless the deployment has consciously accepted that distinction.

The SDK requires exactly one handler for every operation. It validates action envelopes, decodes inputs, runs the configured hook, dispatches at most once after `continue`, and validates the declared outcome. A `stop` becomes the operation's ordinary declared `Err`; it is not a special policy outcome.

Hooks are optional host integration points, not built-in authorization. If this operation can also be reached outside SafeScript, its handler or downstream task service should enforce authority as defense in depth. A host with several checks composes them inside its one `beforeAction` callback and owns their order.

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
const checked = await safe.check({ slot: 'onEvent', source, includeArtifact: true });

if (checked.status !== 'accepted') {
  console.error(checked);
  process.exitCode = 1;
} else if (checked.artifact) {
  const result = await safe.execute({
    slot: 'onEvent',
    program: { kind: 'artifact', bytes: checked.artifact },
    input: { workspaceId: 'acme', title: 'Follow up' },
    context: { allowedWorkspaces: ['acme'] },
    idempotencySeed: new TextEncoder().encode('demo-run-1'),
    trace: true,
  });

  console.log(result);
}

await safe.close();
```

Always observe `close()` during orderly shutdown. A worker lost during an invocation is not replayed; reconcile any external action with unknown effect state before deciding whether application-level retry is safe.

You can execute `{ kind: "source", source }` for the compile-and-run fast path or the accepted artifact bytes. Artifact execution revalidates compatibility and integrity and uses the same gateway, hooks, and handlers as source execution.

For reuse across worker or process lifetimes, a host can provide `artifactStore` to `createSafeScript`. SafeScript derives the keys and verifies loaded bytes. The host supplies and operates the storage system. Most integrations do not need this option.

## Next steps

- Read the [language guide](language.md) before writing non-trivial extensions.
- Read the [SDK guide](sdk.md) for limits, deterministic inputs, cancellation, inspection, and testing.
- Run the complete interactive [CRM example](../examples/crm/README.md) with `bun run --cwd examples/crm demo`.
