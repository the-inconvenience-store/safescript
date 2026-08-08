import { AUTOMATIONS } from '../fixtures/automations.js';
import { createFakeCrm } from './fixture.js';

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function createFakeCrmWebApp() {
  let crm = createFakeCrm();

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(await crm.render(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json({ state: crm.store.snapshot() });
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        await crm.safe.close();
        crm = createFakeCrm();
        return json({ state: crm.store.snapshot() });
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/run/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/run/'.length));
        const automation = AUTOMATIONS.find((candidate) => candidate.id === id);
        if (!automation) return json({ error: 'Unknown automation' }, 404);
        crm.store.receiveEvent(automation.id, automation.input);
        const result = await crm.run(automation);
        const actions =
          result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled'
            ? result.facts.actions
                .filter((record) => record.phase === 'requested')
                .map((record) => {
                  const resolution = result.facts.actions.find(
                    (candidate) => candidate.phase === 'resolved' && candidate.requestId === record.request.requestId,
                  );
                  return {
                    operationId: record.request.operationId,
                    effectId: record.request.effectId,
                    outcome: resolution?.phase === 'resolved' ? resolution.outcome.result.tag : 'unresolved',
                  };
                })
            : [];
        return json({
          status: result.status,
          output: result.status === 'completed' ? result.output : undefined,
          actions,
          state: crm.store.snapshot(),
        });
      }
      return json({ error: 'Not found' }, 404);
    },
    async close(): Promise<void> {
      await crm.safe.close();
    },
  };
}

const port = Number(Bun.env.PORT ?? 4317);

if (import.meta.main) {
  const app = createFakeCrmWebApp();
  Bun.serve({ port, fetch: app.fetch });
  console.info(`SafeScript fake CRM: http://localhost:${port}`);
}
