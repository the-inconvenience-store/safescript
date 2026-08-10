# SafeScript CRM example

This example embeds the public `@safescript/sdk` into an in-memory CRM. It starts with one workspace, deal, contact,
and two owners. Every automation receives an event about those same records, so running scripts visibly changes a
single connected model: stages and owners update, tags accumulate, and tasks, notes, follow-ups, notifications, and
audit records appear.

Run the example with:

```bash
bun run --cwd examples/crm demo
```

Then open <http://localhost:4317>, choose an automation, and press **Run script**. The graph highlights each observed
host action while the CRM state and activity panels update. **Reset CRM** restores the common starting state.

## Reading the example

The code is arranged in the order data travels through the application:

1. [`src/actions.ts`](src/actions.ts) defines host operations such as `notes.create` and `followups.schedule`, including
   their request/result schemas, operation permissions, and costs.
2. [`src/contract.ts`](src/contract.ts) places those actions in the CRM automation slot and defines its event/result.
3. [`src/scripts/index.ts`](src/scripts/index.ts) contains the canonical restricted TypeScript programs. Every action
   payload is written explicitly; there is no source-generating `mutation()` helper hiding what crosses the boundary.
4. [`src/automations.ts`](src/automations.ts) is only the catalog connecting script bodies to names, events, and expected
   operations.
5. [`src/runtime.ts`](src/runtime.ts) connects each contract operation to a trusted handler, configures a host-owned
   `beforeAction` access check, and creates the SafeScript facade.
6. [`src/crm/model.ts`](src/crm/model.ts) describes the shared state and its baseline records;
   [`src/crm/store.ts`](src/crm/store.ts) applies the resulting trusted effects to those records.
7. [`src/graph/project.ts`](src/graph/project.ts) derives readable, connected nodes from the public semantic graph.
8. [`src/web/server.ts`](src/web/server.ts) exposes the page and run/reset endpoints. Page markup, browser behavior,
   and dark-mode styling are isolated in `dashboard.ts`, `client.ts`, and `styles.ts` beside it.
9. [`tests/integration.test.ts`](tests/integration.test.ts) verifies the complete public-SDK path.

The website never interprets its graph. Canonical TypeScript is compiled and executed by SafeScript; the canvas is a
host-owned, read-only projection of `safe.inspect(..., views: ['semantic_graph'])`. Its nodes include branch conditions,
action inputs, and return values, and its edges preserve the visible control flow. Nothing reaches into compiler or
interpreter internals. The dark interface uses the typography, neutral surfaces, hairline borders, compact radii, and
reduced-motion behavior established by the referenced Twenty design guide.
