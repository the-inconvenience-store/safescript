/** Dark CRM workbench styles, kept separate from markup and behavior. */
export const dashboardStyles = String.raw`
* { box-sizing: border-box; }
:root {
  color-scheme: dark;
  --ink: #f0efed;
  --ink-80: #f0efedcc;
  --ink-60: #f0efed99;
  --ink-40: #f0efed66;
  --ink-20: #f0efed33;
  --ink-10: #f0efed1a;
  --ink-5: #f0efed0d;
  --paper: #141414;
  --canvas: #0d0d0d;
  --serif: Georgia, 'Times New Roman', serif;
  --sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --mono: 'SFMono-Regular', Consolas, monospace;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
}
body { margin: 0; overflow: hidden; background: var(--paper); color: var(--ink); }
button { color: var(--ink); font: inherit; }
.app { display: grid; grid-template-columns: 264px minmax(520px, 1fr) 352px; height: 100vh; }
.sidebar, .inspector { overflow: auto; background: var(--paper); }
.sidebar { padding: 32px 16px; border-right: 1px solid var(--ink-10); }
.brand { padding: 0 8px 32px; }
.brand strong { display: block; font: 300 22px var(--serif); }
.brand small { display: block; margin-top: 8px; color: var(--ink-60); font: 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.brand i { display: inline-block; width: 9px; height: 9px; margin-right: 8px; background: var(--ink); }
.automation-button {
  display: flex;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  margin-bottom: 4px;
  padding: 12px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color .25s, border-color .25s, transform .25s;
}
.automation-button:hover { transform: translateY(-1px); border-color: var(--ink-10); background: var(--ink-5); }
.automation-button.selected { border-color: var(--ink-20); background: var(--ink-5); }
.automation-button > span { color: var(--ink-40); font: 10px var(--mono); }
.automation-button strong { display: block; font-size: 13px; font-weight: 400; }
.automation-button small { display: block; color: var(--ink-60); font: 10px var(--mono); }
.workspace { display: grid; grid-template-rows: auto 1fr; min-width: 0; }
.toolbar { display: flex; align-items: center; justify-content: space-between; height: 96px; padding: 0 32px; border-bottom: 1px solid var(--ink-10); }
.toolbar h1 { margin: 0; color: var(--ink); font: 300 28px var(--serif); letter-spacing: -.02em; }
.toolbar p { max-width: 62ch; margin: 6px 0 0; color: var(--ink-60); font-size: 12px; }
.actions { display: flex; align-items: center; gap: 8px; }
.actions button, .icon-button { min-height: 40px; padding: 9px 14px; border: 1px solid var(--ink-10); border-radius: 4px; background: var(--paper); cursor: pointer; }
.actions button:hover, .icon-button:hover { border-color: var(--ink-20); background: var(--ink-5); }
.actions .run { padding: 9px 20px; border-color: var(--ink); background: var(--ink); color: var(--paper); font-weight: 500; }
.actions .run.running { animation: quiet-pulse 1.2s ease-in-out infinite; }
.actions button:disabled { opacity: .65; }
.run-status { margin-right: 6px; color: var(--ink-60); font: 10px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.graph-viewport { position: relative; overflow: hidden; background: var(--canvas); cursor: grab; }
.graph-viewport:active { cursor: grabbing; }
.graph-stage { position: absolute; transform-origin: 0 0; transition: transform .08s ease-out; }
.edge-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.edge-layer marker path { fill: var(--ink-40); }
.graph-edge { fill: none; stroke: var(--ink-20); stroke-width: 1.5; }
.edge-data { stroke-dasharray: 5 5; }
.edge-label { fill: var(--ink-60); stroke: var(--canvas); stroke-width: 7px; paint-order: stroke; font: 9px var(--mono); text-anchor: middle; }
.graph-node {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  overflow: visible;
  border: 1px solid var(--ink-10);
  border-radius: 4px;
  background: var(--paper);
  color: var(--ink);
  transition: border-color .25s, box-shadow .25s, transform .25s;
}
.graph-node:hover { transform: translateY(-2px); border-color: var(--ink-20); box-shadow: 0 12px 32px -16px #000a; }
.graph-node:focus { outline: 2px solid var(--ink); outline-offset: 4px; }
.graph-node > div { min-width: 0; flex: 1; }
.graph-node strong { display: block; max-width: 248px; overflow: hidden; font-size: 15px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.graph-node small { display: -webkit-box; max-width: 248px; margin-top: 7px; overflow: hidden; color: var(--ink-60); font: 11px/1.4 var(--mono); -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.node-icon { width: 12px; height: 12px; flex: none; border: 2px solid var(--ink-60); background: var(--paper); }
.kind-control .node-icon { transform: rotate(45deg); }
.kind-action .node-icon { border-color: var(--ink); border-radius: 50%; background: var(--ink); }
.graph-node.active { transform: translateY(-2px); border-color: var(--ink); box-shadow: 0 0 0 3px var(--ink-10); }
.graph-node.completed { border-color: var(--ink); }
.graph-node.active::after, .graph-node.completed::after { position: absolute; top: -25px; right: 8px; color: var(--ink); font: 9px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.graph-node.active::after { content: 'Running'; }
.graph-node.completed::after { content: '✓ Complete'; }
.port { position: absolute; left: calc(50% - 4px); width: 9px; height: 9px; border: 1px solid var(--ink-40); border-radius: 50%; background: var(--paper); }
.port-in { top: -5px; }
.port-out { bottom: -5px; }
.canvas-tools { position: absolute; z-index: 4; bottom: 16px; left: 16px; display: flex; gap: 6px; }
.readonly { position: absolute; z-index: 4; right: 18px; bottom: 18px; padding: 8px 12px; border: 1px solid var(--ink-10); border-radius: 999px; background: var(--paper); color: var(--ink-60); font: 9px var(--mono); letter-spacing: .08em; }
.inspector { display: grid; grid-template-rows: minmax(210px, 1.2fr) minmax(170px, .8fr) minmax(180px, 1fr) minmax(200px, 1fr); border-left: 1px solid var(--ink-10); }
.panel { padding: 24px; overflow: auto; border-bottom: 1px solid var(--ink-10); }
.panel h2 { margin: 0 0 16px; color: var(--ink-60); font: 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.panel pre { margin: 0; color: var(--ink-80); font: 10px/1.6 var(--mono); overflow-wrap: anywhere; white-space: pre-wrap; }
.activity { margin: 0; padding: 0; list-style: none; }
.activity li { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--ink-10); font-size: 12px; }
.activity li > span { width: 7px; height: 7px; margin-top: 4px; flex: none; border-radius: 50%; background: var(--ink-40); }
.activity li.success > span { background: var(--ink); }
.activity li.failure > span { border: 1px solid var(--ink); background: transparent; }
.activity strong, .activity small { display: block; }
.activity strong { font-weight: 400; }
.activity small, .activity .empty { margin-top: 3px; color: var(--ink-60); }
.reset { float: right; border: 0; background: none; color: var(--ink-60); font: 10px var(--mono); letter-spacing: .06em; text-transform: uppercase; cursor: pointer; }
button:focus { outline: 2px solid var(--ink); outline-offset: 4px; }
@keyframes quiet-pulse { 50% { opacity: .72; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 1050px) { .app { grid-template-columns: 220px 1fr; } .inspector { display: none; } }
@media (max-width: 720px) { .app { grid-template-columns: 1fr; } .sidebar { display: none; } .toolbar { padding: 0 16px; } .toolbar p, .run-status, #reset-crm { display: none; } }
`;
