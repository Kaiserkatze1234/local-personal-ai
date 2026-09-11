/**
 * Chat/agent surface — spec §44. Distinguishes responses, actions, tool
 * execution, permission states and verification without letting logs
 * dominate. The prompt assistant rides alongside as optional chips (§20).
 */
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { PromptSuggestion } from '../../shared/types/events.js';
import * as api from '../lib/api.js';
import { useStore } from '../state/store.js';

function renderAssistantContent(text: string): ReactElement {
  // pull [verification] lines out into a styled footer
  const lines = text.split('\n');
  const body: string[] = [];
  const verify: string[] = [];
  for (const l of lines) {
    if (l.startsWith('[verification]')) verify.push(l);
    else body.push(l);
  }
  return (
    <>
      {body.join('\n')}
      {verify.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {verify.map((v, i) => (
            <div key={i} className={v.includes('passed') ? 'verify-ok' : 'verify-fail'}>
              {v}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ChatPanel(): ReactElement {
  const s = useStore();
  const [draft, setDraft] = useState('');
  const [attachShot, setAttachShot] = useState<{ mimeType: string; dataBase64: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [s.messages]);

  const acceptSuggestion = (sug: PromptSuggestion): void => {
    setDraft((d) => (sug.insertable ? `${d.trim()}${sug.insertable}` : d));
    setPromptAnalyzed(draft);
  };
  const setPromptAnalyzed = (_t: string): void => {
    // suggestions are advisory: accepting either inserts text or dismisses
  };

  const onSend = async (): Promise<void> => {
    const text = draft;
    setDraft('');
    setAttachShot(null);
    await s.send(text, attachShot ? [attachShot] : undefined);
  };

  const capture = async (): Promise<void> => {
    try {
      const shot = await api.call('screen.capture');
      setAttachShot(shot);
    } catch (err) {
      s.setMode(s.mode);
      useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
    }
  };

  return (
    <div className="chat">
      <div className="chat-scroll scroll" ref={scrollRef}>
        {s.messages.length === 0 ? (
          <div className="empty-chat">
            <h1>What should we do?</h1>
            <div>
              <span className="muted">Local-first · your model · your machine</span>
            </div>
            <div className="hint">
              Ask normally — "mach das schneller", "guck mal warum das nicht geht". Pick Agent or Coding mode for tool work; the AI plans,
              uses approved tools, and verifies what it changed.
            </div>
          </div>
        ) : (
          <div className="chat-inner">
            {s.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="who">
                  {m.role === 'user' ? 'you' : 'local ai'}
                  {m.streaming ? ' ·' : ''}
                </div>
                <div className="bubble">{m.role === 'assistant' ? renderAssistantContent(String(m.content)) : String(m.content)}</div>
              </div>
            ))}
            {s.sending && s.mode !== 'CHAT' && (
              <div className="muted small" style={{ textAlign: 'center', padding: 8 }}>
                task running — watch the Tasks panel for steps…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          {s.promptSuggestions.length > 0 && (
            <div className="suggest-row">
              {s.promptSuggestions.map((sg) => (
                <button key={sg.id} className="suggest" title="accept" onClick={() => acceptSuggestion(sg)}>
                  💡 {sg.text.length > 90 ? `${sg.text.slice(0, 90)}…` : sg.text}
                </button>
              ))}
              <button
                className="suggest"
                style={{ borderStyle: 'solid', opacity: 0.6 }}
                onClick={() => useStore.setState({ promptSuggestions: [] })}
              >
                ignore
              </button>
            </div>
          )}
          {attachShot && (
            <div className="row small muted">
              <img
                src={`data:${attachShot.mimeType};base64,${attachShot.dataBase64}`}
                alt="screen attachment"
                style={{ maxHeight: 46, borderRadius: 6 }}
              />
              screen attached
              <button className="ghost" onClick={() => setAttachShot(null)}>
                remove
              </button>
            </div>
          )}
          <div className="composer-row">
            <textarea
              value={draft}
              placeholder={
                s.mode === 'CHAT'
                  ? 'Ask anything… (Enter to send, Shift+Enter for newline)'
                  : 'Describe the task… e.g. "find why the build fails, fix it and verify"'
              }
              rows={Math.min(6, Math.max(2, draft.split('\n').length))}
              onChange={(e) => {
                setDraft(e.target.value);
                s.analyzePrompt(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!s.sending) void onSend();
                }
              }}
            />
            <button title="attach current screen (needs a vision-capable model)" onClick={() => void capture()}>
              📷
            </button>
            {s.sending ? (
              <button className="danger" onClick={() => void s.cancelChat()}>
                Stop
              </button>
            ) : (
              <button className="primary" disabled={!draft.trim()} onClick={() => void onSend()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
