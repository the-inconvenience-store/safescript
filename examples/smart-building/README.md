# SafeScript smart-building semantic editor

This example is a complete bidirectional React Flow editor for a restricted TypeScript building automation. A deterministic zone sensor fixture feeds calculations and branches that can request HVAC, lighting, alert, and audit operations from the host.

```sh
bun install
bun run --cwd examples/smart-building dev
```

Open <http://localhost:4173>. Select graph nodes to see only the edits advertised for that semantic target. The source editor, check/run controls, deliberately limited run, undo/redo, diagnostics, action records, results, traces, and resource usage all use the public `@safescript/sdk` facade.

## Bidirectional lifecycle

```text
host-owned accepted TypeScript
        │
        ├── inspect(semantic_graph + semantic_edit_capabilities)
        │        └── decoded facts → React Flow projection and controls
        │
visual intent → advertised SemanticEdit + manifest preconditions
        │
        └── applySemanticEdits(source + exact base revision)
                 ├── rejected → keep accepted source and graph unchanged
                 └── accepted → adopt returned complete source
                                  └── inspect again
                                       └── reconcile layout with stable IDs + semantic diff
```

Source-to-graph edits send a complete draft to `inspect`. A rejected draft stays visible in the browser with its diagnostics, but it never replaces the controller's last accepted document. Graph-to-source edits send a small UI intent to the server; [`operations.ts`](src/editor/operations.ts) looks up the exact capability, validates finite choices and anchors, copies its mandatory preconditions, and constructs the corresponding semantic operation. No client request contains a graph or graph bytes.

The example owns history as complete accepted source programs. Undo and redo re-inspect retained source rather than treating a semantic diff as an inverse patch. [`reconcile.ts`](src/editor/reconcile.ts) uses unchanged semantic identities and the accepted edit's before/after correspondence to keep positions stable; added nodes receive deterministic projection positions.

The modules deliberately keep responsibilities narrow:

- [`projection.ts`](src/editor/projection.ts) derives React Flow nodes, edges, typed ports, and control descriptors from the graph and capability manifest.
- [`operations.ts`](src/editor/operations.ts) translates visual intents into the closed public semantic-edit algebra.
- [`document.ts`](src/editor/document.ts) owns accepted source, revision checks, re-inspection, failure preservation, and source-based undo/redo.
- [`runtime.ts`](src/runtime.ts) composes the SDK contract, host policy, deterministic execution, and document controller.
- [`client/components`](src/client/components) contains the React Flow canvas, capability inspector, canonical source panel, and execution output.
- [`fixtures.ts`](src/fixtures.ts) fixes the module, telemetry, instant, random seed, and invocation sequence used by integration and browser tests.

## Security boundary

The semantic graph is disposable, read-only metadata. It is never compiler input, executable input, an authority grant, or a document format. Canonical TypeScript is the only representation accepted for checking and execution. `applySemanticEdits` resolves graph identities against a private checked model and returns completely rechecked source; rejected edits expose no candidate source.

Capability inspection says what the compiler can transform, not what the invocation is authorised to do. During execution every action request crosses the SDK's typed gateway and the host-local policy checks the current building scope before a trusted handler runs. The worker has no ambient file, network, process, package, environment, or credential access. Resource exhaustion is a visible terminal execution result and does not change the accepted editor document.

## Tests

```sh
bun run --cwd examples/smart-building test:integration
bun run --cwd examples/smart-building build:web
bun run --cwd examples/smart-building test:browser
```

The integration suite drives real `check`, `inspect`, `applySemanticEdits`, and `execute` calls through the public SDK. Playwright proves rendered source→graph and graph→checked-source changes plus check/run output in Chromium.
