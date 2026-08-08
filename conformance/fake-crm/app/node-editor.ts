import type { SemanticGraph, SemanticGraphEdge, SemanticGraphNode } from '@safescript/contracts';

export interface EditorNode {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly column: number;
  readonly row: number;
}

export interface ReadonlyNodeEditor {
  readonly nodes: readonly EditorNode[];
  readonly edges: readonly SemanticGraphEdge[];
}

const interesting = (node: SemanticGraphNode): boolean =>
  node.semanticKind === 'handler' ||
  node.kind === 'control' ||
  node.kind === 'action' ||
  node.semanticKind === 'return-value';

/** A deliberately lossy visual projection whose source of truth is only the compiler semantic graph. */
export function projectNodeEditor(graph: SemanticGraph): ReadonlyNodeEditor {
  const selected = graph.nodes.filter(interesting);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const nodes = selected.map((node, index) => ({
    id: node.id,
    title: node.label ?? node.operationId ?? node.semanticKind,
    detail: node.operationId ?? node.semanticKind,
    column: node.kind === 'action' ? 2 : node.kind === 'control' ? 1 : 0,
    row: index,
  }));
  const edges = graph.edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to));
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}

const escape = (value: unknown): string =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function renderNodeEditor(name: string, graph: SemanticGraph): string {
  const editor = projectNodeEditor(graph);
  return `<section class="automation" data-source-hash="${escape(graph.sourceHash)}">
    <header><div><h2>${escape(name)}</h2><small>${editor.nodes.length} nodes · ${editor.edges.length} edges</small></div><span>READ ONLY</span></header>
    <div class="canvas" role="img" aria-label="Semantic graph for ${escape(name)}">
      ${editor.nodes
        .map(
          (node) => `<article class="node node-${node.column}" data-semantic-node="${escape(node.id)}">
        <strong>${escape(node.title)}</strong><small>${escape(node.detail)}</small></article>`,
        )
        .join('')}
      <div class="connections" aria-label="Semantic connections">${editor.edges
        .map(
          (edge) =>
            `<i class="edge" data-from="${escape(edge.from)}" data-to="${escape(edge.to)}">→ ${escape(edge.kind)}</i>`,
        )
        .join('')}</div>
    </div>
  </section>`;
}

export function renderDashboard(editors: readonly string[], state: unknown): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>SafeScript CRM fixture</title><style>
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#09111f;color:#dce7f7}body{margin:0;padding:32px;background:radial-gradient(circle at top,#162c45,#09111f 45%)}
  main{max-width:1280px;margin:auto}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:24px}.hero h1{margin:0;font-size:34px}.hero p{color:#91a4bc;margin:8px 0 0}.status{color:#63e6be}
  .layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:20px}.editors{display:grid;gap:18px}.automation,.state{background:#101d2d;border:1px solid #263a51;border-radius:14px;box-shadow:0 16px 50px #0005;overflow:hidden}
  header{display:flex;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #263a51}h2{font-size:15px;margin:0}small{display:block;color:#8298b3;margin-top:4px}header span{font-size:10px;letter-spacing:.14em;color:#7dd3fc;border:1px solid #275873;border-radius:999px;padding:6px 9px;height:min-content}
  .canvas{padding:16px;min-height:110px;display:grid;grid-template-columns:repeat(3,1fr);gap:9px;position:relative}.node{padding:10px;border:1px solid #36506d;background:#17283c;border-radius:8px;min-width:0}.node strong{font-size:12px;overflow-wrap:anywhere}.node-1{border-color:#776a2c;background:#2d2918}.node-2{border-color:#286850;background:#143126}.connections{grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap;border-top:1px dashed #2a4058;padding-top:9px}.edge{font-size:9px;color:#6f8ba8;background:#0c1724;border-radius:999px;padding:3px 6px}
  .state{position:sticky;top:20px;height:min-content;padding:18px}.state h2{font-size:18px}.state pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#a7f3d0;font-size:11px;line-height:1.5}@media(max-width:850px){.layout{grid-template-columns:1fr}.state{position:static}}
  </style></head><body><main><div class="hero"><div><h1>SafeScript CRM lab</h1><p>Compiler-derived automation graphs and observable host effects.</p></div><strong class="status">● v1 live</strong></div>
  <div class="layout"><div class="editors">${editors.join('')}</div><aside class="state"><h2>CRM state after run</h2><pre>${escape(JSON.stringify(state, null, 2))}</pre></aside></div>
  </main></body></html>`;
}
