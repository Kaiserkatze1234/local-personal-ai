/** Memory review — §16/§18: candidates need confirmation, everything inspectable and deletable. */
import { type ReactElement, useState } from 'react';
import { L } from '../lib/i18n.js';
import { useStore } from '../state/store.js';

export function MemoryPanel(): ReactElement {
  const s = useStore();
  const [q, setQ] = useState('');
  const candidates = s.memory.filter((m) => m.status === 'candidate');
  const stored = s.memory.filter((m) => m.status === 'stored');
  return (
    <div className="panel">
      <h2>{L('Memory')}</h2>
      <p className="sub">
        {L('Stable preferences, facts and verified task outcomes. Nothing is stored silently — candidates appear here first.')}
      </p>

      <div className="card">
        <div className="row">
          <input className="grow" placeholder="Search memory…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button
            onClick={() => {
              if (q.trim()) void s.searchMemory(q.trim());
            }}
          >
            Search
          </button>
          <button
            className="primary"
            onClick={() => {
              if (q.trim()) {
                void s.addMemory(q.trim());
                setQ('');
              }
            }}
          >
            ＋ Remember this
          </button>
        </div>
        {s.memoryHits.length > 0 && (
          <>
            <h3 style={{ marginTop: 14 }}>Search results</h3>
            {s.memoryHits.map((h) => (
              <div key={h.entry.id} className="small" style={{ marginBottom: 6 }}>
                <span className="muted">{Math.round(h.score * 100)}%</span> <b>{h.entry.type}</b> — {h.entry.content.slice(0, 160)}
              </div>
            ))}
          </>
        )}
      </div>

      {candidates.length > 0 && (
        <div className="card">
          <h3>Awaiting your review ({candidates.length})</h3>
          {candidates.map((m) => (
            <div key={m.id} className="row" style={{ marginBottom: 8 }}>
              <div className="grow">
                <span className="status-pill">{m.type}</span> {m.content.slice(0, 180)}
              </div>
              <button className="primary" onClick={() => void s.confirmMemory(m.id)}>
                keep
              </button>
              <button className="danger" onClick={() => void s.deleteMemory(m.id)}>
                forget
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Stored ({stored.length})</h3>
        {stored.length === 0 && (
          <div className="small muted">
            Empty. Say something like “remember that I prefer pnpm over npm” in chat — or use “Remember this” above.
          </div>
        )}
        {stored.map((m) => (
          <div key={m.id} className="row" style={{ marginBottom: 6 }}>
            <span className="status-pill">{m.type}</span>
            <span className="grow">{m.content.slice(0, 200)}</span>
            <span className="small muted" title={`importance ${m.importance}, confidence ${m.confidence}`}>
              imp {Math.round(m.importance * 100)} · used {m.usedCount}×
            </span>
            <button className="ghost" onClick={() => void s.deleteMemory(m.id)}>
              delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
