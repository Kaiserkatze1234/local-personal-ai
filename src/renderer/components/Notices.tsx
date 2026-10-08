/** Proactive notices — shown inline, dismissible, rate-limited by the core (§27). */
import type { ReactElement } from 'react';
import { useStore } from '../state/store.js';

export function Notices(): ReactElement | null {
  const s = useStore();
  if (s.notices.length === 0) return null;
  return (
    <div className="notices">
      {s.notices.map((n) => (
        <div key={n.id} className="notice">
          <div>{n.text}</div>
          <div className="why">
            {n.reason} · confidence {Math.round(n.confidence * 100)}%
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="ghost" onClick={() => s.dismissNotice(n.id)}>
              dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
