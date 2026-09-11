/**
 * Overlay window entry — spec §23/§46. Compact card, low resource, closable,
 * shows proactive suggestions + active task status pushed from main.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onOverlayText } from './lib/api.js';
import './styles.css';

function OverlayApp(): ReactElement {
  const [text, setText] = useState<string>('Idle — no active tasks.');
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => onOverlayText((t) => setText(t)), []);

  if (hidden)
    return (
      <div className="overlay-root overlay-hidden" onClick={() => setHidden(false)}>
        ○
      </div>
    );
  return (
    <div className={`overlay-root ${expanded ? 'overlay-expanded' : ''}`}>
      <div className="overlay-head">
        <span className="overlay-dot" />
        <span>Local AI</span>
        <button className="overlay-btn" onClick={() => setExpanded(!expanded)} title="expand">
          {expanded ? '–' : '+'}
        </button>
        <button className="overlay-btn" onClick={() => setHidden(true)} title="dismiss">
          ×
        </button>
      </div>
      <div className="overlay-body">{text}</div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<OverlayApp />);
