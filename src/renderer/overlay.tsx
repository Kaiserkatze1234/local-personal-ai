/**
 * Overlay window entry — spec §23/§46. Compact card, low resource, closable.
 * Normal mode: interactive (status line + quick "what is on my screen" ask).
 * Low-resource mode: display-only (main process makes it click-through).
 */
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call, onOverlayText } from './lib/api.js';
import './styles.css';

function OverlayApp(): ReactElement {
  const [text, setText] = useState<string>('Idle — no active tasks.');
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => onOverlayText((t) => setText(t)), []);

  const ask = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      let images: { mimeType: string; dataBase64: string }[] | undefined;
      try {
        const shot = await call('screen.capture');
        images = [shot];
      } catch {
        /* no screen source — ask anyway, as a plain question */
      }
      const res = await call('chat.send', {
        text: question.trim() || 'What is on my screen? Note anything that looks like a problem.',
        mode: 'CHAT',
        images,
      });
      const msgs = await call('conversations.messages', res.conversationId);
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      setText(String(last?.content ?? 'No answer (is a vision-capable model bound?).'));
    } catch (err) {
      setText(err instanceof Error ? err.message : 'Ask failed.');
    } finally {
      setBusy(false);
    }
  }, [question]);

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
      {expanded && (
        <div className="overlay-ask">
          <input
            value={question}
            placeholder="ask about your screen…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void ask();
            }}
          />
          <button onClick={() => void ask()} disabled={busy}>
            {busy ? '…' : 'ask'}
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<OverlayApp />);
