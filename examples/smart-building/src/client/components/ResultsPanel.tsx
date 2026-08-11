export function ResultsPanel({ result }: Readonly<{ result?: unknown }>) {
  return (
    <section className="results" aria-live="polite" aria-labelledby="results-heading">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">SafeScript SDK</span>
          <h2 id="results-heading">Diagnostics &amp; execution</h2>
        </div>
      </header>
      {result === undefined ? (
        <p className="panel-note">
          Check or run to inspect diagnostics, action requests, results, traces, and resource usage.
        </p>
      ) : (
        <pre>{JSON.stringify(result, null, 2)}</pre>
      )}
    </section>
  );
}
