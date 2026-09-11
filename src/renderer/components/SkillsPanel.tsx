/** Learned workflows — §18/§19: reviewable, toggleable, removable. */
import { type ReactElement, useState } from 'react';
import * as api from '../lib/api.js';
import { useStore } from '../state/store.js';

export function SkillsPanel(): ReactElement {
  const s = useStore();
  const [show, setShow] = useState<string | null>(null);
  const learned = s.skills.filter((k) => k.source === 'learned');
  const manual = s.skills.filter((k) => k.source !== 'learned');
  return (
    <div className="panel">
      <h2>Skills</h2>
      <p className="sub">Reusable procedures — learned from confirmed workflows or added by you. Skills never bypass permissions.</p>
      {learned.length > 0 && (
        <div className="card">
          <h3>Learned from your corrections</h3>
          {learned.map((k) => (
            <div key={k.id}>
              <div className="row" style={{ marginBottom: 4 }}>
                <b>{k.name}</b>
                <span className="status-pill">conf {Math.round(k.confidence * 100)}%</span>
                <div className="grow" />
                <button className="ghost" onClick={() => setShow(show === k.id ? null : k.id)}>
                  {show === k.id ? 'hide' : 'detail'}
                </button>
                <button onClick={() => void s.toggleSkill(k.id, !k.enabled)}>{k.enabled ? 'disable' : 'enable'}</button>
                <button className="danger" onClick={() => void s.deleteSkill(k.id)}>
                  delete
                </button>
              </div>
              <div className="small muted">{k.description}</div>
              {show === k.id && (
                <div className="mono small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                  {k.instructions}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <h3>Defined ({manual.length})</h3>
        {manual.length === 0 && learned.length === 0 && (
          <div className="small muted">
            Nothing yet. When you correct the AI the same way twice and confirm the fix works, a workflow candidate appears here for review.
          </div>
        )}
        {manual.map((k) => (
          <div key={k.id} className="row" style={{ marginBottom: 4 }}>
            <b>{k.name}</b>
            <span className="grow small muted">{k.description}</span>
            <button className="danger" onClick={() => void s.deleteSkill(k.id)}>
              delete
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            onClick={async () => {
              const name = window.prompt('Skill name');
              if (!name) return;
              const description = window.prompt('Short description (what is it for)?') ?? name;
              const instructions = window.prompt('What should the AI do (the procedure)?');
              if (!instructions) return;
              try {
                await api.call('skills.add', name, description, instructions);
                useStore.setState({ error: null });
                await useStore.getState().loadSidePanels();
              } catch (err) {
                useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
              }
            }}
          >
            ＋ New skill
          </button>
        </div>
      </div>
    </div>
  );
}
