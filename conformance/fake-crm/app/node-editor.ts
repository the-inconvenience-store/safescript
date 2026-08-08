import type { OperationId, SemanticGraph, SemanticGraphEdge, SemanticGraphNode } from '@safescript/contracts';

export interface EditorNode {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly kind: 'handler' | 'control' | 'action' | 'return';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly operationId?: OperationId;
}

export interface ReadonlyNodeEditor {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly EditorNode[];
  readonly edges: readonly SemanticGraphEdge[];
}

export interface DashboardAutomation {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly editor: ReadonlyNodeEditor;
}

const interesting = (node: SemanticGraphNode): boolean =>
  node.semanticKind === 'handler' ||
  node.kind === 'control' ||
  node.kind === 'action' ||
  node.semanticKind === 'return-value';

function visualKind(node: SemanticGraphNode): EditorNode['kind'] {
  if (node.kind === 'action') return 'action';
  if (node.kind === 'control') return 'control';
  if (node.semanticKind === 'return-value') return 'return';
  return 'handler';
}

/** Host-owned 2D projection built exclusively from public semantic graph facts. */
export function projectNodeEditor(graph: SemanticGraph): ReadonlyNodeEditor {
  const selected = graph.nodes.filter(interesting);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const edges = graph.edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to));
  const columns: Record<EditorNode['kind'], SemanticGraphNode[]> = {
    handler: [],
    control: [],
    action: [],
    return: [],
  };
  for (const node of selected) columns[visualKind(node)].push(node);

  const xByKind: Record<EditorNode['kind'], number> = { handler: 70, control: 350, action: 650, return: 950 };
  const columnCount = Math.max(...Object.values(columns).map((nodes) => nodes.length), 1);
  const canvasHeight = Math.max(520, columnCount * 116 + 100);
  const nodes = (Object.entries(columns) as [EditorNode['kind'], SemanticGraphNode[]][]).flatMap(([kind, facts]) => {
    const totalHeight = Math.max(0, (facts.length - 1) * 116);
    const startY = (canvasHeight - totalHeight) / 2 - 36;
    return facts.map((node, index) => ({
      id: node.id,
      title: node.label ?? node.operationId ?? node.semanticKind,
      detail: node.operationId ?? node.semanticKind,
      kind,
      x: xByKind[kind],
      y: startY + index * 116,
      width: 210,
      height: 72,
      ...(node.operationId === undefined ? {} : { operationId: node.operationId }),
    }));
  });
  return Object.freeze({
    width: 1230,
    height: canvasHeight,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

const escape = (value: unknown): string =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function graphMarkup(editor: ReadonlyNodeEditor): string {
  const byId = new Map(editor.nodes.map((node) => [node.id, node]));
  return `<svg class="edge-layer" viewBox="0 0 ${editor.width} ${editor.height}" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${editor.edges
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const bend = Math.max(45, (x2 - x1) / 2);
      return `<path class="graph-edge edge-${escape(edge.kind)}" data-from="${escape(edge.from)}" data-to="${escape(edge.to)}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#arrow)"/>`;
    })
    .join('')}</svg>${editor.nodes
    .map(
      (node) =>
        `<article class="graph-node kind-${node.kind}" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px" data-semantic-node="${escape(node.id)}"${node.operationId === undefined ? '' : ` data-operation="${escape(node.operationId)}"`} tabindex="0"><span class="node-icon"></span><div><strong>${escape(node.title)}</strong><small>${escape(node.detail)}</small></div><b class="port port-in"></b><b class="port port-out"></b></article>`,
    )
    .join('')}`;
}

export function renderNodeEditor(name: string, graph: SemanticGraph): string {
  const editor = projectNodeEditor(graph);
  return `<section class="automation" data-source-hash="${escape(graph.sourceHash)}"><header><h2>${escape(name)}</h2><span>READ ONLY</span></header><div class="canvas"><div class="graph-stage" style="width:${editor.width}px;height:${editor.height}px">${graphMarkup(editor)}</div></div></section>`;
}

const clientScript = String.raw`
(() => {
  const automations = window.__CRM_AUTOMATIONS__;
  const list = document.querySelector('#automation-list');
  const stage = document.querySelector('#graph-stage');
  const viewport = document.querySelector('#graph-viewport');
  const title = document.querySelector('#script-title');
  const description = document.querySelector('#script-description');
  const source = document.querySelector('#source-code');
  const state = document.querySelector('#crm-state');
  const activity = document.querySelector('#activity');
  const runButton = document.querySelector('#run-script');
  const resetButton = document.querySelector('#reset-crm');
  const runStatus = document.querySelector('#run-status');
  let selected = automations[0];
  let scale = 0.82;
  let translateX = 24;
  let translateY = 24;
  let dragging = false;
  let dragX = 0;
  let dragY = 0;

  const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const edgePath = (edge, nodes) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.max(45, (x2 - x1) / 2);
    return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
  };
  const applyTransform = () => { stage.style.transform = 'translate(' + translateX + 'px,' + translateY + 'px) scale(' + scale + ')'; };
  const renderState = (value) => { state.textContent = JSON.stringify(value, null, 2); };
  const addActivity = (label, detail, tone) => {
    if (activity.querySelector('.empty')) activity.innerHTML = '';
    const item = document.createElement('li');
    item.className = tone || '';
    item.innerHTML = '<span></span><div><strong>' + escapeHtml(label) + '</strong><small>' + escapeHtml(detail) + '</small></div>';
    activity.prepend(item);
  };
  const resetView = () => {
    const width = viewport.clientWidth || 900;
    const height = viewport.clientHeight || 600;
    scale = Math.min(0.9, (width - 70) / selected.editor.width, (height - 70) / selected.editor.height);
    translateX = Math.max(28, (width - selected.editor.width * scale) / 2);
    translateY = Math.max(28, (height - selected.editor.height * scale) / 2);
    applyTransform();
  };
  const renderGraph = () => {
    const editor = selected.editor;
    const nodes = new Map(editor.nodes.map((node) => [node.id, node]));
    stage.style.width = editor.width + 'px';
    stage.style.height = editor.height + 'px';
    stage.innerHTML = '<svg class="edge-layer" viewBox="0 0 ' + editor.width + ' ' + editor.height + '" aria-hidden="true"><defs><marker id="arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>' + editor.edges.map((edge) => '<path class="graph-edge edge-' + edge.kind + '" data-from="' + edge.from + '" data-to="' + edge.to + '" d="' + edgePath(edge, nodes) + '" marker-end="url(#arrow-live)"/>').join('') + '</svg>' + editor.nodes.map((node) => '<article class="graph-node kind-' + node.kind + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px;height:' + node.height + 'px" data-semantic-node="' + node.id + '"' + (node.operationId ? ' data-operation="' + node.operationId + '"' : '') + ' tabindex="0"><span class="node-icon"></span><div><strong>' + escapeHtml(node.title) + '</strong><small>' + escapeHtml(node.detail) + '</small></div><b class="port port-in"></b><b class="port port-out"></b></article>').join('');
    resetView();
  };
  const select = (automation) => {
    selected = automation;
    document.querySelectorAll('.automation-button').forEach((button) => button.classList.toggle('selected', button.dataset.id === automation.id));
    title.textContent = automation.name;
    description.textContent = automation.description;
    source.textContent = automation.source;
    runStatus.textContent = 'Ready';
    renderGraph();
  };

  automations.forEach((automation, index) => {
    const button = document.createElement('button');
    button.className = 'automation-button';
    button.dataset.id = automation.id;
    button.innerHTML = '<span>' + String(index + 1).padStart(2, '0') + '</span><div><strong>' + escapeHtml(automation.name) + '</strong><small>' + automation.editor.nodes.filter((node) => node.kind === 'action').length + ' action nodes</small></div>';
    button.addEventListener('click', () => select(automation));
    list.append(button);
  });

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    runButton.classList.add('running');
    runStatus.textContent = 'Compiling and running…';
    stage.querySelectorAll('.active,.completed').forEach((node) => node.classList.remove('active', 'completed'));
    try {
      const response = await fetch('/api/run/' + encodeURIComponent(selected.id), { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Run failed');
      for (const action of result.actions) {
        const node = stage.querySelector('[data-operation="' + CSS.escape(action.operationId) + '"]');
        if (node) {
          node.classList.add('active');
          node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          await new Promise((resolve) => setTimeout(resolve, 380));
          node.classList.remove('active');
          node.classList.add('completed');
        }
        addActivity(action.operationId.replace('operation:', ''), action.outcome, action.outcome === 'completed' ? 'success' : 'failure');
      }
      renderState(result.state);
      runStatus.textContent = result.status === 'completed' ? 'Completed · ' + result.actions.length + ' action' + (result.actions.length === 1 ? '' : 's') : result.status;
      addActivity(selected.name, 'SafeScript execution ' + result.status, result.status === 'completed' ? 'success' : 'failure');
    } catch (error) {
      runStatus.textContent = error instanceof Error ? error.message : 'Run failed';
      addActivity(selected.name, runStatus.textContent, 'failure');
    } finally {
      runButton.disabled = false;
      runButton.classList.remove('running');
    }
  });

  resetButton.addEventListener('click', async () => {
    const response = await fetch('/api/reset', { method: 'POST' });
    const result = await response.json();
    renderState(result.state);
    activity.innerHTML = '<li class="empty">Run an automation to see its verified host effects.</li>';
    stage.querySelectorAll('.active,.completed').forEach((node) => node.classList.remove('active', 'completed'));
    runStatus.textContent = 'CRM reset';
  });
  document.querySelector('#zoom-in').addEventListener('click', () => { scale = Math.min(1.7, scale + 0.12); applyTransform(); });
  document.querySelector('#zoom-out').addEventListener('click', () => { scale = Math.max(0.35, scale - 0.12); applyTransform(); });
  document.querySelector('#fit-view').addEventListener('click', resetView);
  viewport.addEventListener('wheel', (event) => { event.preventDefault(); scale = Math.max(0.35, Math.min(1.7, scale - event.deltaY * 0.001)); applyTransform(); }, { passive: false });
  viewport.addEventListener('pointerdown', (event) => { if (event.target.closest('.graph-node')) return; dragging = true; dragX = event.clientX - translateX; dragY = event.clientY - translateY; viewport.setPointerCapture(event.pointerId); });
  viewport.addEventListener('pointermove', (event) => { if (!dragging) return; translateX = event.clientX - dragX; translateY = event.clientY - dragY; applyTransform(); });
  viewport.addEventListener('pointerup', () => { dragging = false; });
  select(selected);
})();`;

export function renderDashboard(automations: readonly DashboardAutomation[], initialState: unknown): string {
  const data = JSON.stringify(automations).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SafeScript CRM fixture</title><style>
  /* Superseded prototype rules retained inert during the design-system migration.
  *{box-sizing:border-box}:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#07101c;color:#dce7f7}body{margin:0;overflow:hidden;background:#07101c}button{font:inherit;color:inherit}.app{height:100vh;display:grid;grid-template-columns:260px minmax(500px,1fr) 330px}.sidebar,.inspector{background:#0b1624;border-color:#203247;overflow:auto}.sidebar{border-right:1px solid #203247;padding:22px 14px}.brand{padding:0 10px 22px}.brand strong{display:block;font-size:18px}.brand small{color:#7890aa}.brand i{display:inline-block;width:8px;height:8px;background:#55e6a5;border-radius:50%;box-shadow:0 0 14px #55e6a5;margin-right:7px}.automation-button{width:100%;display:flex;gap:11px;text-align:left;padding:11px;border:1px solid transparent;background:transparent;border-radius:10px;cursor:pointer;margin-bottom:5px}.automation-button:hover{background:#111f31}.automation-button.selected{background:#13283d;border-color:#285376}.automation-button>span{font:10px ui-monospace;color:#65809c;padding-top:2px}.automation-button strong{display:block;font-size:12px}.automation-button small{color:#71879e;font-size:10px}.workspace{display:grid;grid-template-rows:auto 1fr;min-width:0}.toolbar{height:80px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid #203247;background:#0b1624}.toolbar h1{font-size:17px;margin:0}.toolbar p{font-size:11px;color:#7890aa;margin:5px 0 0}.actions{display:flex;align-items:center;gap:8px}.actions button,.icon-button{border:1px solid #294159;background:#111f31;border-radius:8px;padding:8px 11px;cursor:pointer}.actions button:hover,.icon-button:hover{border-color:#3e6d95}.actions .run{background:#24a66e;border-color:#37c68a;color:white;font-weight:700;padding:9px 18px}.actions .run.running{animation:pulse 1s infinite}.actions button:disabled{opacity:.6}.run-status{font-size:10px;color:#7f96ad;margin-right:6px}.graph-viewport{position:relative;overflow:hidden;cursor:grab;background-color:#091522;background-image:radial-gradient(#294059 1px,transparent 1px);background-size:22px 22px}.graph-viewport:active{cursor:grabbing}.graph-stage{position:absolute;transform-origin:0 0;transition:transform .08s ease-out}.edge-layer{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.edge-layer marker path{fill:#49637d}.graph-edge{fill:none;stroke:#38516b;stroke-width:2}.edge-control{stroke:#755f2f}.edge-data{stroke:#286c62;stroke-dasharray:6 5}.graph-node{position:absolute;border:1px solid #36516d;background:#142439;border-radius:10px;padding:13px 14px;display:flex;gap:11px;align-items:center;box-shadow:0 10px 24px #0005;transition:border-color .2s,box-shadow .2s,transform .2s;overflow:visible}.graph-node:focus{outline:2px solid #4ea7ec}.graph-node strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:158px}.graph-node small{display:block;color:#7991aa;font-size:9px;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:158px}.node-icon{width:12px;height:12px;border:3px solid #75a3cf;border-radius:3px;flex:none}.kind-control{border-color:#77652f;background:#292619}.kind-control .node-icon{border-color:#e2bf59;transform:rotate(45deg)}.kind-action{border-color:#2c8065;background:#123128}.kind-action .node-icon{border-radius:50%;border-color:#58dcad}.kind-return{border-color:#6b4a83;background:#241b30}.kind-return .node-icon{border-color:#c78bea}.graph-node.active{border-color:#f6d365;box-shadow:0 0 0 4px #f6d36533,0 0 35px #f6d36566;transform:scale(1.06)}.graph-node.completed{border-color:#55e6a5;box-shadow:0 0 0 3px #55e6a522}.port{position:absolute;width:9px;height:9px;border:2px solid #6384a2;background:#0b1624;border-radius:50%;top:calc(50% - 4px)}.port-in{left:-5px}.port-out{right:-5px}.canvas-tools{position:absolute;left:16px;bottom:16px;display:flex;gap:6px;z-index:4}.icon-button{background:#0e1c2c;padding:7px 10px}.readonly{position:absolute;right:18px;bottom:18px;z-index:4;font-size:9px;letter-spacing:.14em;color:#7dd3fc;background:#0b1624dd;border:1px solid #275873;border-radius:99px;padding:7px 10px}.inspector{border-left:1px solid #203247;display:grid;grid-template-rows:minmax(180px,1fr) minmax(180px,1fr) minmax(160px,1fr)}.panel{padding:18px;border-bottom:1px solid #203247;overflow:auto}.panel h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#7f96ad;margin:0 0 12px}.panel pre{font:10px/1.5 ui-monospace,SFMono-Regular;color:#9de5c7;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.source pre{color:#a9bdd2}.activity{list-style:none;padding:0;margin:0}.activity li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #182a3d;font-size:11px}.activity li>span{width:7px;height:7px;border-radius:50%;background:#668099;margin-top:4px;flex:none}.activity li.success>span{background:#55e6a5}.activity li.failure>span{background:#ef6f7b}.activity strong{display:block}.activity small{color:#7890aa;margin-top:3px}.activity .empty{color:#647b92;border:0}.reset{float:right;background:none;border:0;color:#78bcea;cursor:pointer;font-size:10px}@keyframes pulse{50%{box-shadow:0 0 18px #37c68a88}}@media(max-width:1050px){.app{grid-template-columns:210px 1fr}.inspector{display:none}}@media(max-width:720px){.app{grid-template-columns:1fr}.sidebar{display:none}}
  */
  *{box-sizing:border-box}:root{color-scheme:dark;--ink:#f0efed;--ink-80:#f0efedcc;--ink-60:#f0efed99;--ink-40:#f0efed66;--ink-20:#f0efed33;--ink-10:#f0efed1a;--ink-5:#f0efed0d;--paper:#141414;--canvas:#0d0d0d;--font-serif:Georgia,'Times New Roman',serif;--font-sans:Inter,ui-sans-serif,system-ui,sans-serif;--font-mono:'SFMono-Regular',Consolas,monospace;background:var(--paper);color:var(--ink);font-family:var(--font-sans)}
  body{margin:0;overflow:hidden}.app{height:100vh;display:grid}.sidebar,.inspector{overflow:auto}.brand strong,.brand small,.graph-node strong,.graph-node small,.activity strong,.activity small{display:block}.brand i{display:inline-block}.automation-button{width:100%;display:flex;text-align:left;cursor:pointer;background:transparent}.workspace{display:grid;grid-template-rows:auto 1fr;min-width:0}.toolbar{display:flex;align-items:center;justify-content:space-between}.toolbar h1,.toolbar p,.panel h2,.panel pre{margin:0}.actions{display:flex;align-items:center}.actions button,.icon-button{cursor:pointer}.run-status{margin-right:6px}.graph-viewport{position:relative;overflow:hidden;cursor:grab}.graph-viewport:active{cursor:grabbing}.graph-stage{position:absolute;transform-origin:0 0;transition:transform .08s ease-out}.edge-layer{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.graph-edge{fill:none}.graph-node{position:absolute;display:flex;gap:12px;align-items:center;overflow:visible}.graph-node strong,.graph-node small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:158px}.node-icon{flex:none}.port{position:absolute;width:9px;height:9px;border-radius:50%;top:calc(50% - 4px)}.port-in{left:-5px}.port-out{right:-5px}.canvas-tools{position:absolute;left:16px;bottom:16px;display:flex;gap:6px;z-index:4}.readonly{position:absolute;right:18px;bottom:18px;z-index:4}.inspector{display:grid}.panel{overflow:auto}.activity{list-style:none;padding:0;margin:0}.activity li{display:flex;gap:10px}.activity li>span{width:7px;height:7px;border-radius:50%;margin-top:4px;flex:none}.reset{float:right;background:none;border:0;cursor:pointer}
  body{background:var(--paper);color:var(--ink)}button{color:var(--ink);font-weight:400}.app{grid-template-columns:264px minmax(520px,1fr) 352px}.sidebar,.inspector{background:var(--paper);border-color:var(--ink-10)}.sidebar{border-right:1px solid var(--ink-10);padding:32px 16px}.brand{padding:0 8px 32px}.brand strong{font-family:var(--font-serif);font-size:22px;font-weight:300}.brand small{font:11px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-60);margin-top:8px}.brand i{width:9px;height:9px;background:var(--ink);border-radius:0;box-shadow:none;margin-right:8px}.automation-button{min-height:48px;gap:12px;padding:12px 10px;border:1px solid transparent;border-radius:4px;margin-bottom:4px;transition:background-color .25s ease,border-color .25s ease,transform .25s ease}.automation-button:hover{background:var(--ink-5);border-color:var(--ink-10);transform:translateY(-1px)}.automation-button.selected{background:var(--ink-5);border-color:var(--ink-20)}.automation-button>span{font:10px var(--font-mono);color:var(--ink-40)}.automation-button strong{font-size:13px;font-weight:400}.automation-button small{font:10px var(--font-mono);color:var(--ink-60)}
  .toolbar{height:96px;padding:0 32px;border-color:var(--ink-10);background:var(--paper)}.toolbar h1{font-family:var(--font-serif);font-size:28px;font-weight:300;letter-spacing:-.02em;color:var(--ink)}.toolbar p{max-width:62ch;font-size:12px;color:var(--ink-60);margin-top:6px}.actions{gap:8px}.actions button,.icon-button{min-height:40px;border:1px solid var(--ink-10);background:var(--paper);border-radius:4px;padding:9px 14px;transition:border-color .25s ease,background-color .25s ease}.actions button:hover,.icon-button:hover{border-color:var(--ink-20);background:var(--ink-5)}.actions .run{background:var(--ink);border-color:var(--ink);color:var(--paper);font-weight:500;padding:9px 20px}.actions .run:hover{background:#fff;border-color:#fff}.actions .run.running{animation:quiet-pulse 1.2s ease-in-out infinite}.run-status{font:10px var(--font-mono);color:var(--ink-60);text-transform:uppercase;letter-spacing:.06em}
  .graph-viewport{background-color:var(--canvas);background-image:none}.edge-layer marker path{fill:var(--ink-40)}.graph-edge,.edge-control,.edge-data{stroke:var(--ink-20);stroke-width:1.5}.edge-data{stroke-dasharray:5 5}.graph-node,.kind-control,.kind-action,.kind-return{border:1px solid var(--ink-10);background:var(--paper);border-radius:4px;box-shadow:none;color:var(--ink);padding:14px 16px;transition:border-color .25s ease,box-shadow .25s ease,transform .25s ease}.graph-node:hover{border-color:var(--ink-20);box-shadow:0 12px 32px -16px rgba(0,0,0,.65);transform:translateY(-2px)}.graph-node:focus{outline:2px solid var(--ink);outline-offset:4px}.graph-node strong{font-size:13px;font-weight:400}.graph-node small{font:9px var(--font-mono);color:var(--ink-60);letter-spacing:.02em}.node-icon,.kind-control .node-icon,.kind-action .node-icon,.kind-return .node-icon{border:2px solid var(--ink-60);background:var(--paper)}.kind-action .node-icon{background:var(--ink);border-color:var(--ink)}.kind-control .node-icon{transform:rotate(45deg)}.graph-node.active{border-color:var(--ink);box-shadow:0 0 0 3px var(--ink-10),0 12px 32px -16px rgba(0,0,0,.65);transform:translateY(-2px)}.graph-node.active::after{content:'Running';position:absolute;right:8px;top:-25px;font:9px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}.graph-node.completed{border-color:var(--ink);box-shadow:none}.graph-node.completed::after{content:'✓ Complete';position:absolute;right:8px;top:-25px;font:9px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}.port{border:1px solid var(--ink-40);background:var(--paper)}.icon-button{background:var(--paper)}.readonly{font:9px var(--font-mono);letter-spacing:.08em;color:var(--ink-60);background:var(--paper);border:1px solid var(--ink-10);border-radius:999px;padding:8px 12px}
  .inspector{border-color:var(--ink-10);grid-template-rows:minmax(190px,1fr) minmax(190px,1fr) minmax(180px,1fr)}.panel{padding:24px;border-color:var(--ink-10)}.panel h2{font:10px var(--font-mono);letter-spacing:.08em;color:var(--ink-60);margin-bottom:16px}.panel pre,.source pre{font:10px/1.6 var(--font-mono);color:var(--ink-80)}.activity li{padding:10px 0;border-color:var(--ink-10);font-size:12px}.activity li>span,.activity li.success>span{background:var(--ink)}.activity li.failure>span{background:transparent;border:1px solid var(--ink)}.activity strong{font-weight:400}.activity small,.activity .empty{color:var(--ink-60)}.reset{color:var(--ink-60);font:10px var(--font-mono);text-transform:uppercase;letter-spacing:.06em}.reset:focus,.automation-button:focus,.actions button:focus,.icon-button:focus{outline:2px solid var(--ink);outline-offset:4px}
  @keyframes quiet-pulse{50%{opacity:.72}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.automation-button:hover,.graph-node:hover{transform:none}}@media(max-width:1050px){.app{grid-template-columns:220px 1fr}.inspector{display:none}}@media(max-width:720px){.app{grid-template-columns:1fr}.sidebar{display:none}.toolbar{padding:0 16px}.toolbar p,.run-status,#reset-crm{display:none}}
  </style></head><body><div class="app"><nav class="sidebar"><div class="brand"><strong><i></i>SafeScript CRM</strong><small>Automation laboratory</small></div><div id="automation-list"></div></nav><main class="workspace"><header class="toolbar"><div><h1 id="script-title"></h1><p id="script-description"></p></div><div class="actions"><span class="run-status" id="run-status">Ready</span><button id="reset-crm">Reset CRM</button><button class="run" id="run-script">▶ Run script</button></div></header><section class="graph-viewport" id="graph-viewport" aria-label="Read-only semantic graph editor"><div class="graph-stage" id="graph-stage"></div><div class="canvas-tools"><button class="icon-button" id="zoom-out" aria-label="Zoom out">−</button><button class="icon-button" id="fit-view">Fit</button><button class="icon-button" id="zoom-in" aria-label="Zoom in">+</button></div><span class="readonly">READ ONLY · SEMANTIC GRAPH</span></section></main><aside class="inspector"><section class="panel"><button class="reset" id="reset-crm-side" onclick="document.querySelector('#reset-crm').click()">Reset</button><h2>CRM state</h2><pre id="crm-state">${escape(JSON.stringify(initialState, null, 2))}</pre></section><section class="panel"><h2>Execution activity</h2><ul class="activity" id="activity"><li class="empty">Run an automation to see its verified host effects.</li></ul></section><section class="panel source"><h2>Canonical TypeScript</h2><pre id="source-code"></pre></section></aside></div><script>window.__CRM_AUTOMATIONS__=${data};</script><script>${clientScript}</script></body></html>`;
}
