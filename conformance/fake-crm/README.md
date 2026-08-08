# SafeScript fake CRM

This independent conformance workspace embeds the public `@safescript/sdk` into a small in-memory CRM. Its ten stored
TypeScript automations live in `fixtures/`; the trusted host, semantic-graph projection, and demo server live in `app/`;
and all black-box behavior tests live in `tests/`. Nothing reaches into compiler or interpreter internals.

Run the browser fixture with:

```bash
bun run --cwd conformance/fake-crm demo
```

Then open <http://localhost:4317>. Each request runs the automations in a fresh CRM, displays their read-only node views
derived from `safe.inspect(..., views: ["semantic_graph"])`, and shows the resulting CRM state beside them.
