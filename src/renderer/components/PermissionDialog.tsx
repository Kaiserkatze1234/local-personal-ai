/** Confirmation dialog for tool actions (§11) — shows exactly what will happen. */
import type { ReactElement } from 'react';
import { L } from '../lib/i18n.js';
import { useStore } from '../state/store.js';

export function PermissionDialog(): ReactElement | null {
  const s = useStore();
  const req = s.permissionQueue[0];
  if (!req) return null;
  return (
    <div className="modal-wrap">
      <div className="modal">
        {req.flaggedDangerous && <div className="danger-flag">⚠ flagged as potentially destructive</div>}
        <h3 style={{ marginTop: 0 }}>{L('Permission needed')}</h3>
        <div className="kv">
          <div className="muted">permission</div>
          <div className="mono">{req.permission}</div>
          <div className="muted">action</div>
          <div>{req.action}</div>
          <div className="muted">detail</div>
          <div className="mono" style={{ wordBreak: 'break-all' }}>
            {req.detail}
          </div>
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => void s.decidePermission(req.id, 'deny')}>{L('Deny')}</button>
          <button onClick={() => void s.decidePermission(req.id, 'allow_once')}>{L('Allow once')}</button>
          <button onClick={() => void s.decidePermission(req.id, 'allow_session')}>{L('Allow for session')}</button>
          <button className="primary" onClick={() => void s.decidePermission(req.id, 'allow_persistent')}>
            {L('Allow always')}
          </button>
        </div>
        {s.permissionQueue.length > 1 && (
          <div className="small muted" style={{ marginTop: 8 }}>
            {s.permissionQueue.length - 1} more request(s) queued
          </div>
        )}
      </div>
    </div>
  );
}
