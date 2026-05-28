/**
 * Minimal smoke test: import a few components from @hyperframes/studio,
 * see if Vite can compile them and the page renders without crashing.
 *
 * If this works, the next step is wiring our project's frame HTML into
 * <Player> as a live source.
 */
import { useState } from 'react';
import { SourceEditor } from '@hyperframes/studio';

const SAMPLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0f0a2e;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center}
h1{font-size:8vw;letter-spacing:-.02em}
</style></head><body>
<h1 data-hv-text="headline">Open Design</h1>
</body></html>`;

export function App() {
  const [html, setHtml] = useState(SAMPLE_HTML);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100vh', gap: 12, padding: 12 }}>
      <div style={{ background: '#1a1a1f', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a2a30', fontSize: 12, color: '#8a8a90' }}>
          @hyperframes/studio · SourceEditor
        </div>
        <SourceEditor
          value={html}
          language="html"
          onChange={setHtml}
        />
      </div>
      <div style={{ background: '#000', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
        <iframe
          srcDoc={html}
          sandbox="allow-scripts"
          style={{ width: '100%', height: '100%', border: 0 }}
        />
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: 'rgba(255,255,255,.4)', fontFamily: 'monospace' }}>
          live preview
        </div>
      </div>
    </div>
  );
}
