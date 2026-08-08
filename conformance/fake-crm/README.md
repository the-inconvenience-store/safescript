# SafeScript fake CRM

This independent conformance workspace embeds the public `@safescript/sdk` into a small in-memory CRM. Its ten stored
TypeScript automations live in `fixtures/`; the trusted host, semantic-graph projection, and demo server live in `app/`;
and all black-box behavior tests live in `tests/`. Nothing reaches into compiler or interpreter internals.

Run the browser fixture with:

```bash
bun run --cwd conformance/fake-crm demo
```

Then open <http://localhost:4317>. Choose any automation and press **Run script**. The browser calls the fixture API,
which executes the stored source through `createSafeScript`; the graph highlights every observed host action and the CRM
state and execution activity update in place. Reset clears all fixture effects.

The canvas is a host-owned, read-only projection of `safe.inspect(..., views: ["semantic_graph"])`: its positioned
nodes and SVG connections carry the semantic graph IDs, while pan, wheel zoom, fit-to-view, focus, and script selection
behave like a real graph viewer. Canonical TypeScript remains the only executable authority.

The website follows the restrained light visual system in the referenced Twenty `DESIGN.md`: serif display hierarchy,
mono metadata, neutral surfaces, hairline borders, 4px cards, a deep-ink primary action, and reduced-motion support.
