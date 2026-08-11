export function SourcePanel({
  source,
  accepted,
  busy,
  onChange,
  onAccept,
}: Readonly<{
  source: string;
  accepted: boolean;
  busy: boolean;
  onChange: (source: string) => void;
  onAccept: () => void;
}>) {
  return (
    <section className="source-panel" aria-labelledby="source-heading">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">Canonical document</span>
          <h2 id="source-heading">TypeScript source</h2>
        </div>
        <span className={`source-state ${accepted ? 'is-accepted' : ''}`}>{accepted ? 'Accepted' : 'Draft'}</span>
      </header>
      <textarea
        aria-label="Canonical SafeScript TypeScript source"
        spellCheck={false}
        value={source}
        onChange={(event) => onChange(event.target.value)}
      />
      <button className="button button--primary" type="button" disabled={busy || accepted} onClick={onAccept}>
        Check &amp; accept source
      </button>
      <p className="panel-note">The graph is rebuilt only after this complete source passes SafeScript inspection.</p>
    </section>
  );
}
