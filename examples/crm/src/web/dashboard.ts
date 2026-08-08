import type { ReadonlyNodeEditor } from '../graph/project.js';
import { dashboardClient } from './client.js';
import { dashboardStyles } from './styles.js';

export interface DashboardAutomation {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly event: Readonly<Record<string, string>>;
  readonly source: string;
  readonly sourceHash: string;
  readonly editor: ReadonlyNodeEditor;
}

const escapeHtml = (value: unknown): string =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Produces the self-contained workbench page served by this example. */
export function renderDashboard(automations: readonly DashboardAutomation[], initialState: unknown): string {
  const automationData = JSON.stringify(automations).replaceAll('<', '\\u003c');
  const state = escapeHtml(JSON.stringify(initialState, null, 2));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>SafeScript CRM example</title>
    <style>${dashboardStyles}</style>
  </head>
  <body>
    <div class="app">
      <nav class="sidebar" aria-label="CRM automations">
        <div class="brand"><strong><i></i>SafeScript CRM</strong><small>Automation laboratory</small></div>
        <div id="automation-list"></div>
      </nav>
      <main class="workspace">
        <header class="toolbar">
          <div><h1 id="script-title"></h1><p id="script-description"></p></div>
          <div class="actions">
            <span class="run-status" id="run-status">Ready</span>
            <button id="reset-crm">Reset CRM</button>
            <button class="run" id="run-script">▶ Run script</button>
          </div>
        </header>
        <section class="graph-viewport" id="graph-viewport" aria-label="Read-only semantic graph editor">
          <div class="graph-stage" id="graph-stage"></div>
          <div class="canvas-tools">
            <button class="icon-button" id="zoom-out" aria-label="Zoom out">−</button>
            <button class="icon-button" id="fit-view">Fit</button>
            <button class="icon-button" id="zoom-in" aria-label="Zoom in">+</button>
          </div>
          <span class="readonly">READ ONLY · SEMANTIC GRAPH</span>
        </section>
      </main>
      <aside class="inspector">
        <section class="panel">
          <button class="reset" id="reset-crm-side">Reset</button>
          <h2>CRM state</h2><pre id="crm-state">${state}</pre>
        </section>
        <section class="panel"><h2>Selected event</h2><pre id="event-data"></pre></section>
        <section class="panel">
          <h2>Execution activity</h2>
          <ul class="activity" id="activity"><li class="empty">Run an automation to see its verified host effects.</li></ul>
        </section>
        <section class="panel source"><h2>Canonical TypeScript</h2><pre id="source-code"></pre></section>
      </aside>
    </div>
    <script>window.__CRM_AUTOMATIONS__=${automationData};</script>
    <script>${dashboardClient}</script>
  </body>
</html>`;
}
