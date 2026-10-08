/** Task transparency — §9/§3.7: every run shows phases, tools, model choice. */
import type { ReactElement } from 'react';
import type { TaskRecord } from '../../shared/types/task.js';
import { L } from '../lib/i18n.js';
import { useStore } from '../state/store.js';

function TaskCard({ t }: { t: TaskRecord }): ReactElement {
  const s = useStore();
  const active = ['queued', 'analyzing', 'executing', 'verifying', 'waiting_for_permission'].includes(t.status);
  return (
    <div className={`card task ${t.status}`}>
      <div className="row">
        <b>{t.title}</b>
        <span className="status-pill">{t.status}</span>
        <div className="grow" />
        {active && (
          <button
            className="danger"
            onClick={() => {
              void s.cancelTask(t.id);
            }}
          >
            Stop
          </button>
        )}
        {t.status === 'paused' && (
          <>
            <button onClick={() => void s.recoverTask(t.id, 'rerun')}>{L('Resume (rerun)')}</button>
            <button className="ghost" onClick={() => void s.recoverTask(t.id, 'discard')}>
              {L('Discard')}
            </button>
          </>
        )}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {t.userRequest.slice(0, 220)}
      </div>
      {t.phases.length > 0 && (
        <div className="phasebar">
          {t.phases.map((p, i) => (
            <span key={i} className="phase">
              {p.name}
            </span>
          ))}
        </div>
      )}
      {t.modelSelections.length > 0 && (
        <div className="small muted" style={{ marginTop: 6 }}>
          model: <span className="mono">{t.modelSelections[0]?.modelId}</span> — {t.modelSelections[0]?.reason}
        </div>
      )}
      {t.toolsUsed.length > 0 && (
        <div className="small muted">
          tools: <span className="mono">{t.toolsUsed.join(', ')}</span>
          {t.involvedFiles.length > 0 && (
            <>
              {' '}
              · files: <span className="mono">{t.involvedFiles.slice(0, 4).join(', ')}</span>
              {t.involvedFiles.length > 4 ? ` +${t.involvedFiles.length - 4}` : ''}
            </>
          )}
        </div>
      )}
      {t.verification && (
        <div className={`small ${t.verification.passed ? 'verify-ok' : 'verify-fail'}`} style={{ marginTop: 4 }}>
          verification ({t.verification.method}): {t.verification.passed ? 'passed' : t.verification.attempted ? 'failed' : 'not possible'}
        </div>
      )}
      {t.summary && (
        <div className="small" style={{ marginTop: 6 }}>
          {t.summary}
        </div>
      )}
      {t.errors.length > 0 && (
        <div className="small" style={{ color: 'var(--err)', marginTop: 4 }}>
          {t.errors.length} error(s): {t.errors[t.errors.length - 1]?.message.slice(0, 160)}
        </div>
      )}
      {t.checkpointIds.length > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="small muted">{t.checkpointIds.length} checkpoint(s) — rollback available in Diagnostics panel.</span>
        </div>
      )}
    </div>
  );
}

export function TasksPanel(): ReactElement {
  const s = useStore();
  const sorted = [...s.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="panel">
      <h2>{L('Tasks')}</h2>
      <p className="sub">
        {L('Every agent action is a recoverable task with visible phases.')} {s.tasks.length} record(s).
      </p>
      {sorted.length === 0 && <div className="card muted">{L('No tasks yet — switch to Agent or Coding mode and ask for something.')}</div>}
      {sorted.map((t) => (
        <TaskCard key={t.id} t={t} />
      ))}
    </div>
  );
}
