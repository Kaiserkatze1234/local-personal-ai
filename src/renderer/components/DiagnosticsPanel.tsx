/** Health screen — §50 with checkpoint rollback (§37) right here for convenience. */
import { type ReactElement, useEffect, useState } from 'react';
import type { CheckpointInfo } from '../../shared/types/ipc.js';
import * as api from '../lib/api.js';
import { useStore } from '../state/store.js';

export function DiagnosticsPanel(): ReactElement {
  const s = useStore();
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);

  const loadCkpts = async (): Promise<void> => {
    try {
      setCheckpoints(await api.call('checkpoints.list'));
    } catch {
      /* no bridge */
    }
  };
  useEffect(() => {
    void loadCkpts();
  }, []);

  const h = s.health;
  return (
    <div className="panel">
      <h2>Diagnostics</h2>
      <p className="sub">
        Overall: <b className={h ? `state-${h.overall}` : ''}>{h?.overall ?? '…'}</b> · RAM{' '}
        {h ? `${h.resources.memUsedMb}/${h.resources.memTotalMb} MB` : ''} ·{' '}
        {h?.resources.cpuPercent !== undefined && h ? `CPU ${h.resources.cpuPercent}%` : ''} · mode {h?.resources.resourceMode ?? ''}
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button onClick={() => void s.refreshHealth()}>Refresh</button>
        <button onClick={() => void s.runSelfTest()}>Run self-tests</button>
        <button onClick={() => void s.exportDiagnostics()}>Export diagnostics</button>
      </div>

      <div className="health-grid">
        {(h?.components ?? []).map((c) => (
          <div key={c.id} className="card health-item">
            <span className={`dot ${c.state === 'OK' ? 'ok' : c.state === 'WARNING' ? 'warn' : c.state === 'ERROR' ? 'err' : 'unavail'}`} />
            <div className="grow">
              <div>
                <b>{c.label}</b> <span className={`state state-${c.state}`}>{c.state}</span>
              </div>
              <div className="small">{c.message}</div>
              {c.hints.length > 0 && (
                <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {c.hints.map((hh, i) => (
                    <li key={i}>{hh}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Checkpoints & rollback</h3>
        {checkpoints.length === 0 && (
          <div className="small muted">No checkpoints yet — the agent creates them automatically before risky file changes.</div>
        )}
        {checkpoints.map((ck) => (
          <div key={ck.id} className="row" style={{ marginBottom: 6 }}>
            <span className="mono small">{ck.id}</span>
            <b className="grow">{ck.label}</b>
            <span className="small muted">
              {ck.fileCount} file(s) · {new Date(ck.createdAt).toLocaleString()} {ck.gitHead ? `· git ${ck.gitHead.slice(0, 7)}` : ''}
            </span>
            <button
              onClick={async () => {
                if (!window.confirm(`Restore ${ck.fileCount} file(s) from "${ck.label}"? Current state will be snapshotted first.`)) return;
                const r = await api.call('checkpoints.restore', ck.id);
                useStore.setState({ error: r.ok ? null : r.message });
                await loadCkpts();
              }}
            >
              restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
