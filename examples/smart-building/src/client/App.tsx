import { useEffect, useState } from 'react';

import type { SemanticDiff } from '@safescript/contracts';

import type { SemanticIntent } from '../editor/operations.js';
import type { AcceptedBuildingDocument } from '../runtime.js';
import { editorApi, type EditorResponse } from './api.js';
import { FlowCanvas } from './components/FlowCanvas.js';
import { Inspector } from './components/Inspector.js';
import { ResultsPanel } from './components/ResultsPanel.js';
import { SourcePanel } from './components/SourcePanel.js';

export function App() {
  const [document, setDocument] = useState<AcceptedBuildingDocument>();
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string>();
  const [result, setResult] = useState<unknown>();
  const [diff, setDiff] = useState<SemanticDiff>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void editorApi.open().then((opened) => {
      setDocument(opened);
      setDraft(opened.acceptedSource.source);
    });
  }, []);

  const perform = async (work: () => Promise<EditorResponse>) => {
    setBusy(true);
    try {
      const response = await work();
      setResult(response);
      if (response.status === 'accepted' && response.document) {
        setDocument(response.document);
        setDraft(response.document.acceptedSource.source);
        setDiff(response.diff);
      }
    } finally {
      setBusy(false);
    }
  };

  const history = async (direction: 'undo' | 'redo') => {
    setBusy(true);
    try {
      const restored = await editorApi.history(direction);
      setDocument(restored);
      setDraft(restored.acceptedSource.source);
      setResult({ status: 'accepted', history: direction, semanticRevision: restored.graph.semanticRevision });
      setDiff(undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!document) return <main className="boot">Opening the checked building program…</main>;
  const accepted = draft === document.acceptedSource.source;
  const edit = (intent: SemanticIntent) => perform(() => editorApi.edit(document.graph.semanticRevision, intent));

  return (
    <main className="studio">
      <header className="topbar">
        <div>
          <span className="brand-mark" aria-hidden="true">
            SS
          </span>
          <div>
            <span className="eyebrow">SafeScript 0.7 · semantic editing</span>
            <h1>Building Studio</h1>
          </div>
        </div>
        <div className="topbar-actions" aria-label="Document and execution controls">
          <span className="revision" title={document.graph.semanticRevision}>
            rev {document.graph.semanticRevision.slice(-8)}
          </span>
          <button type="button" disabled={busy || !document.canUndo} onClick={() => history('undo')}>
            Undo
          </button>
          <button type="button" disabled={busy || !document.canRedo} onClick={() => history('redo')}>
            Redo
          </button>
          <button type="button" disabled={busy} onClick={() => void editorApi.check().then(setResult)}>
            Check
          </button>
          <button
            className="button--primary"
            type="button"
            disabled={busy}
            onClick={() => void editorApi.run().then(setResult)}
          >
            Run
          </button>
          <button type="button" disabled={busy} onClick={() => void editorApi.run({ hostCalls: 1 }).then(setResult)}>
            Run limited
          </button>
        </div>
      </header>
      <section className="overview" aria-label="Building fixture">
        <div>
          <span>Zone</span>
          <strong>Level 03 · West</strong>
        </div>
        <div>
          <span>Temperature</span>
          <strong>26.8°C</strong>
        </div>
        <div>
          <span>Humidity</span>
          <strong>68%</strong>
        </div>
        <div>
          <span>Occupancy</span>
          <strong className="live">Occupied</strong>
        </div>
        <div>
          <span>Static action cost</span>
          <strong>{document.graph.resources.potentialEffectCost}</strong>
        </div>
      </section>
      <div className="workspace">
        <div className="graph-column">
          <FlowCanvas flow={document.flow} diff={diff} selected={selected} onSelect={setSelected} />
          <Inspector document={document} selected={selected} busy={busy} onEdit={(intent) => void edit(intent)} />
        </div>
        <div className="code-column">
          <SourcePanel
            source={draft}
            accepted={accepted}
            busy={busy}
            onChange={setDraft}
            onAccept={() => void perform(() => editorApi.source(draft))}
          />
          <ResultsPanel result={result} />
        </div>
      </div>
      <footer>
        <strong>Security boundary:</strong> the canvas is a disposable projection. Only checked TypeScript runs; every
        host action is reauthorised at dispatch.
      </footer>
    </main>
  );
}
