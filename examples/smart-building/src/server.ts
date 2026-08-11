import type { SemanticRevisionId } from '@safescript/contracts';

import type { SemanticIntent } from './editor/operations.js';
import { createBuildingEditor } from './runtime.js';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#081615" />
    <title>SafeScript Building Studio</title>
    <link rel="stylesheet" href="/main.css" />
  </head>
  <body>
    <div id="root"><main class="boot">Opening the checked building program…</main></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>`;

const json = (value: unknown, status = 200): Response =>
  new Response(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item)),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );

const body = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export function createBuildingWebApp() {
  const editor = createBuildingEditor();
  let opening: ReturnType<typeof editor.open> | undefined;
  const open = () => (opening ??= editor.open());
  const publicDir = new URL('../dist/public/', import.meta.url);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === '/')
          return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (request.method === 'GET' && (url.pathname === '/main.js' || url.pathname === '/main.css')) {
          const file = Bun.file(new URL(`.${url.pathname}`, publicDir));
          return (await file.exists())
            ? new Response(file)
            : new Response('Build the web bundle first.', { status: 404 });
        }
        await open();
        if (request.method === 'GET' && url.pathname === '/api/document') return json(editor.current());
        if (request.method === 'POST' && url.pathname === '/api/source') {
          const payload = await body(request);
          return typeof payload.source === 'string'
            ? json(await editor.submitSource(payload.source))
            : json({ status: 'invalid_request', message: 'source must be a string' }, 400);
        }
        if (request.method === 'POST' && url.pathname === '/api/edit') {
          const payload = await body(request);
          if (!payload.intent || typeof payload.revision !== 'string')
            return json({ status: 'invalid_request', message: 'intent and revision are required' }, 400);
          return json(
            await editor.applyIntent(
              payload.intent as SemanticIntent,
              payload.revision as SemanticRevisionId,
              payload.editLimits as never,
            ),
          );
        }
        if (request.method === 'POST' && url.pathname === '/api/history') {
          const payload = await body(request);
          if (payload.direction === 'undo') return json(await editor.undo());
          if (payload.direction === 'redo') return json(await editor.redo());
          return json({ status: 'invalid_request', message: 'direction must be undo or redo' }, 400);
        }
        if (request.method === 'POST' && url.pathname === '/api/check') return json(await editor.check());
        if (request.method === 'POST' && url.pathname === '/api/run') {
          const payload = await body(request);
          return json(await editor.run(payload.limits as never));
        }
        return new Response('Not found', { status: 404 });
      } catch (error) {
        return json(
          {
            status: 'server_error',
            message: error instanceof Error ? error.message : 'unexpected server error',
          },
          500,
        );
      }
    },
    close: () => editor.close(),
  };
}

if (import.meta.main) {
  const app = createBuildingWebApp();
  const port = Number(Bun.env.PORT ?? 4173);
  Bun.serve({ port, fetch: app.fetch });
  console.info(`SafeScript Building Studio: http://localhost:${port}`);
}
