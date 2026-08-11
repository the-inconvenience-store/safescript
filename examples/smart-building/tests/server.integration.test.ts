import { afterEach, describe, expect, it } from 'bun:test';

import type { AcceptedBuildingDocument } from '../src/editor/document.js';
import { createBuildingWebApp } from '../src/server.js';

const apps: ReturnType<typeof createBuildingWebApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('smart-building web API', () => {
  it('serves the React Flow shell and performs source, graph, check, and run requests', async () => {
    const app = createBuildingWebApp();
    apps.push(app);
    const page = await app.fetch(new Request('http://fixture.test/'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('SafeScript Building Studio');

    const opened = await app.fetch(new Request('http://fixture.test/api/document'));
    const initial = (await opened.json()) as AcceptedBuildingDocument;
    expect(initial.acceptedSource.source).toContain('temperatureDelta');
    const literal = initial.graph.nodes.find((node) => node.constant === 'cool to 22C');
    expect(literal).toBeDefined();
    if (!literal) throw new Error('fixture literal was not returned by the API');

    const edited = await app.fetch(
      new Request('http://fixture.test/api/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: initial.graph.semanticRevision,
          intent: { kind: 'set_literal', target: literal.id, value: 'cool to 20C' },
        }),
      }),
    );
    const changed = (await edited.json()) as Readonly<{
      status: string;
      document: AcceptedBuildingDocument;
    }>;
    expect(changed.status).toBe('accepted');
    expect(changed.document.acceptedSource.source).toContain('cool to 20C');

    const checked = await app.fetch(new Request('http://fixture.test/api/check', { method: 'POST' }));
    expect(await checked.json()).toMatchObject({ status: 'accepted', diagnostics: [] });
    const run = await app.fetch(new Request('http://fixture.test/api/run', { method: 'POST' }));
    const execution = (await run.json()) as Readonly<{
      status: string;
      facts: Readonly<{
        actions: readonly unknown[];
        trace: Readonly<{ records: readonly unknown[] }>;
        usage: Readonly<{ hostCalls: number }>;
      }>;
    }>;
    expect(execution.status).toBe('completed');
    expect(execution.facts.actions).toHaveLength(4);
    expect(execution.facts.trace.records.length).toBeGreaterThan(0);
    expect(execution.facts.usage.hostCalls).toBe(2);
  });
});
