/** Browser-only behavior for the read-only graph viewer and execution controls. */
export const dashboardClient = String.raw`
(() => {
  const automations = window.__CRM_AUTOMATIONS__;
  const list = document.querySelector('#automation-list');
  const stage = document.querySelector('#graph-stage');
  const viewport = document.querySelector('#graph-viewport');
  const title = document.querySelector('#script-title');
  const description = document.querySelector('#script-description');
  const source = document.querySelector('#source-code');
  const eventData = document.querySelector('#event-data');
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

  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const applyTransform = () => {
    stage.style.transform = 'translate(' + translateX + 'px,' + translateY + 'px) scale(' + scale + ')';
  };

  const edgePath = (edge, nodes) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height;
    const x2 = to.x + to.width / 2;
    const y2 = to.y;
    const bend = Math.max(24, (y2 - y1) / 2);
    return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + bend) + ', ' + x2 + ' ' + (y2 - bend) + ', ' + x2 + ' ' + y2;
  };

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
    scale = Math.min(0.9, (width - 30) / selected.editor.width, (height - 30) / selected.editor.height);
    translateX = Math.max(12, (width - selected.editor.width * scale) / 2);
    translateY = Math.max(12, (height - selected.editor.height * scale) / 2);
    applyTransform();
  };

  const renderGraph = () => {
    const editor = selected.editor;
    const nodes = new Map(editor.nodes.map((node) => [node.id, node]));
    stage.style.width = editor.width + 'px';
    stage.style.height = editor.height + 'px';
    const edges = editor.edges.map((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      const label = edge.label && from && to
        ? '<text class="edge-label" x="' + ((from.x + from.width / 2 + to.x + to.width / 2) / 2) + '" y="' + ((from.y + from.height + to.y) / 2 - 6) + '">' + escapeHtml(edge.label) + '</text>'
        : '';
      return '<path class="graph-edge edge-' + edge.kind + '" data-from="' + edge.from + '" data-to="' + edge.to + '" d="' + edgePath(edge, nodes) + '" marker-end="url(#arrow-live)"/>' + label;
    }).join('');
    const nodeCards = editor.nodes.map((node) =>
      '<article class="graph-node kind-' + node.kind + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px;height:' + node.height + 'px" data-semantic-node="' + node.id + '"' + (node.operationId ? ' data-operation="' + node.operationId + '"' : '') + ' tabindex="0"><span class="node-icon"></span><div><strong>' + escapeHtml(node.title) + '</strong><small title="' + escapeHtml(node.detail) + '">' + escapeHtml(node.detail) + '</small></div><b class="port port-in"></b><b class="port port-out"></b></article>'
    ).join('');
    stage.innerHTML = '<svg class="edge-layer" viewBox="0 0 ' + editor.width + ' ' + editor.height + '" aria-hidden="true"><defs><marker id="arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>' + edges + '</svg>' + nodeCards;
    resetView();
  };

  const select = (automation) => {
    selected = automation;
    document.querySelectorAll('.automation-button').forEach((button) =>
      button.classList.toggle('selected', button.dataset.id === automation.id)
    );
    title.textContent = automation.name;
    description.textContent = automation.description;
    eventData.textContent = JSON.stringify(automation.event, null, 2);
    source.textContent = automation.source;
    runStatus.textContent = 'Ready';
    renderGraph();
  };

  automations.forEach((automation, index) => {
    const button = document.createElement('button');
    const actionCount = automation.editor.nodes.filter((node) => node.kind === 'action').length;
    button.className = 'automation-button';
    button.dataset.id = automation.id;
    button.innerHTML = '<span>' + String(index + 1).padStart(2, '0') + '</span><div><strong>' + escapeHtml(automation.name) + '</strong><small>' + actionCount + ' action nodes</small></div>';
    button.addEventListener('click', () => select(automation));
    list.append(button);
  });

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    runButton.classList.add('running');
    runStatus.textContent = 'Compiling and running…';
    addActivity('Event received', selected.event.previousStage + ' → ' + selected.event.stage + ' · ' + selected.event.dealId);
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
      state.textContent = JSON.stringify(result.state, null, 2);
      runStatus.textContent = result.status === 'completed'
        ? 'Completed · ' + result.actions.length + ' action' + (result.actions.length === 1 ? '' : 's')
        : result.status;
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
    state.textContent = JSON.stringify(result.state, null, 2);
    activity.innerHTML = '<li class="empty">Run an automation to see its verified host effects.</li>';
    stage.querySelectorAll('.active,.completed').forEach((node) => node.classList.remove('active', 'completed'));
    runStatus.textContent = 'CRM reset';
  });

  document.querySelector('#reset-crm-side').addEventListener('click', () => resetButton.click());
  document.querySelector('#zoom-in').addEventListener('click', () => { scale = Math.min(1.7, scale + 0.12); applyTransform(); });
  document.querySelector('#zoom-out').addEventListener('click', () => { scale = Math.max(0.35, scale - 0.12); applyTransform(); });
  document.querySelector('#fit-view').addEventListener('click', resetView);
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    scale = Math.max(0.35, Math.min(1.7, scale - event.deltaY * 0.001));
    applyTransform();
  }, { passive: false });
  viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.graph-node')) return;
    dragging = true;
    dragX = event.clientX - translateX;
    dragY = event.clientY - translateY;
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    translateX = event.clientX - dragX;
    translateY = event.clientY - dragY;
    applyTransform();
  });
  viewport.addEventListener('pointerup', () => { dragging = false; });
  select(selected);
})();`;
