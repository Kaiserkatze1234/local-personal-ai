/** Project + knowledge panel — §13/§31/§62. Explicit opt-in indexing. */
import { type ReactElement, useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { L } from '../lib/i18n.js';
import { useStore } from '../state/store.js';

interface KnowledgeDoc {
  id: string;
  name: string;
  kind: string;
  size: number;
  createdAt: string;
}

export function ProjectsPanel(): ReactElement {
  const s = useStore();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [manualPath, setManualPath] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        setDocs(await api.call('knowledge.list'));
      } catch {
        /* fine without bridge */
      }
    })();
  }, [s.error, s.knowledgeVersion]);

  return (
    <div className="panel">
      <h2>{L('Projects & knowledge')}</h2>
      <p className="sub">
        The AI only sees what you add here. Directories are indexed incrementally (metadata + previews), never uploaded anywhere.
      </p>

      <div className="card">
        <h3>Add project folder</h3>
        <div className="row">
          <button onClick={() => void s.addProject()}>Pick folder…</button>
          <input
            className="grow"
            placeholder="…or paste a path, e.g. C:\Users\you\code\app"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
          />
          <button
            disabled={!manualPath.trim()}
            onClick={async () => {
              try {
                const p = await api.call('projects.add', manualPath.trim());
                useStore.setState((st) => ({ projects: [p, ...st.projects], activeProjectId: p.id, error: null }));
                setManualPath('');
              } catch (err) {
                useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
              }
            }}
          >
            Index
          </button>
        </div>
      </div>

      {s.projects.map((p) => (
        <div key={p.id} className="card">
          <div className="row">
            <b>{p.name}</b>
            <span className="status-pill">{p.kind}</span>
            <span className="chip">{p.fileCount} files</span>
            {p.isGit && <span className="chip">git</span>}
            {s.activeProjectId === p.id && <span className="chip on">active</span>}
            <div className="grow" />
            <button className="ghost" onClick={() => s.setProject(s.activeProjectId === p.id ? null : p.id)}>
              {s.activeProjectId === p.id ? 'deactivate' : 'use'}
            </button>
            <button className="ghost" onClick={() => void s.reindexProject(p.id)}>
              reindex
            </button>
            <button className="danger" onClick={() => void s.removeProject(p.id)}>
              remove
            </button>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {p.path}
            <br />
            langs: {p.languages.join(', ') || '—'} · frameworks: {p.frameworks.join(', ') || '—'}
            <br />
            verify commands:{' '}
            <span className="mono">{p.testCommands.join(' | ') || 'none detected — code changes here cannot be auto-verified'}</span>
          </div>
        </div>
      ))}

      <div className="card">
        <h3>Knowledge import (documents)</h3>
        <div className="row">
          <button onClick={() => void s.importKnowledge()}>{L('Import file…')}</button>
          <span className="small muted">txt / md / code / json / csv — parsed locally, chunked, searchable by the agent.</span>
        </div>
        {docs.map((d) => (
          <div key={d.id} className="row small" style={{ marginTop: 6 }}>
            <span className="mono grow">{d.name}</span>
            <span className="muted">{d.kind}</span>
            <span className="muted">{Math.round(d.size / 1024)} KB</span>
          </div>
        ))}
        {docs.length === 0 && (
          <div className="small muted" style={{ marginTop: 6 }}>
            Nothing imported yet.
          </div>
        )}
      </div>
    </div>
  );
}
