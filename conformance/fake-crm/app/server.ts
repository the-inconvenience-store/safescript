import { createFakeCrm } from './fixture.js';

const port = Number(Bun.env.PORT ?? 4317);

if (import.meta.main) {
  Bun.serve({
    port,
    async fetch() {
      const crm = createFakeCrm();
      await crm.runAll();
      const html = await crm.render();
      await crm.safe.close();
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  console.info(`SafeScript fake CRM: http://localhost:${port}`);
}
