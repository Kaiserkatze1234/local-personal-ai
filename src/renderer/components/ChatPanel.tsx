/**
 * Chat/agent surface — spec §44. Distinguishes responses, actions, tool
 * execution, permission states and verification without letting logs
 * dominate. The prompt assistant rides alongside as optional chips (§20).
 */
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { PromptSuggestion } from '../../shared/types/events.js';
import * as api from '../lib/api.js';
import { L } from '../lib/i18n.js';
import { resolveSpeechPlayback } from '../lib/playback.js';
import { useStore } from '../state/store.js';

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return btoa(bin);
}

let currentAudio: HTMLAudioElement | null = null;

function stopSpeech(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

function speak(text: string): void {
  stopSpeech(); // interruption: a new utterance cancels the previous one
  void (async () => {
    try {
      const r = await api.call('voice.speak', text.slice(0, 1200));
      const audio = new Audio(`data:${r.mimeType};base64,${r.audioBase64}`);
      const voice = useStore.getState().config?.voice;
      if (voice) {
        const pb = resolveSpeechPlayback(voice, r);
        audio.volume = pb.volume;
        audio.playbackRate = pb.playbackRate;
      }
      currentAudio = audio;
      audio.onended = () => {
        if (currentAudio === audio) currentAudio = null;
      };
      await audio.play();
    } catch (err) {
      useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
    }
  })();
}

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
  const [recording, setRecording] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // push-to-talk: global hotkey (or nothing when voice disabled) — press starts, press stops (§24)
  const toggleRec = (): void => {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    stopSpeech(); // talking over the assistant is how interruption should feel (§24)
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined });
        const parts: Blob[] = [];
        mr.ondataavailable = (e) => parts.push(e.data);
        mr.onstop = () => {
          for (const track of stream.getTracks()) track.stop();
          recRef.current = null;
          setRecording(false);
          void (async () => {
            try {
              const b64 = await blobToBase64(new Blob(parts, { type: 'audio/webm' }));
              const r = await api.call('voice.transcribe', b64, 'audio/webm');
              setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}${r.text}`);
            } catch (err) {
              useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
            }
          })();
        };
        recRef.current = mr;
        mr.start();
        setRecording(true);
      } catch (err) {
        useStore.setState({ error: err instanceof Error ? `Microphone unavailable: ${err.message}` : 'Microphone unavailable' });
      }
    })();
  };
  const toggleRecRef = useRef(toggleRec);
  toggleRecRef.current = toggleRec;
  useEffect(() => api.onPtt(() => toggleRecRef.current()), []);

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
    stopSpeech(); // sending a new message interrupts in-flight TTS (§24)
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
            <h1>{L('What should we do?')}</h1>
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
                <div className="bubble">
                  {m.role === 'assistant' ? renderAssistantContent(String(m.content)) : String(m.content)}
                  {m.role === 'assistant' && !m.streaming && String(m.content).length > 3 && (
                    <div style={{ textAlign: 'right', marginTop: 4 }}>
                      <button
                        className="ghost"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        title={L('read aloud (needs TTS backend)')}
                        onClick={() => speak(String(m.content))}
                      >
                        {L('🔊 speak')}
                      </button>
                    </div>
                  )}
                </div>
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
                  ? L('Ask anything… (Enter to send, Shift+Enter for newline)')
                  : L('Describe the task… e.g. "find why the build fails, fix it and verify"')
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
            <button title={L('attach current screen (needs a vision-capable model)')} onClick={() => void capture()}>
              📷
            </button>
            <button
              title={L('attach a screen region (drag to select)')}
              onClick={() =>
                void (async () => {
                  try {
                    const r = await api.call('screen.captureRegion');
                    if (!('cancelled' in r) || !r.cancelled) setAttachShot({ mimeType: r.mimeType, dataBase64: r.dataBase64 });
                  } catch (err) {
                    useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
                  }
                })()
              }
            >
              🎯
            </button>
            <button
              title={L('analyze a screen recording (needs ffmpeg + vision model)')}
              onClick={() =>
                void (async () => {
                  stopSpeech();
                  try {
                    const r = await api.call('recording.pickAndAnalyze', undefined);
                    if (r.ok && r.summary) setDraft((d) => `${d}${d && !d.endsWith(' ') ? '\n\n' : ''}${r.summary}`);
                    else if (!r.cancelled && r.error) useStore.setState({ error: r.error });
                  } catch (err) {
                    useStore.setState({ error: err instanceof api.ApiError ? err.message : String(err) });
                  }
                })()
              }
            >
              🎬
            </button>
            <button
              title={recording ? 'stop dictation (voice → text)' : 'dictate (push-to-talk; global hotkey also toggles)'}
              className={recording ? 'danger' : ''}
              onClick={() => toggleRec()}
            >
              {recording ? '⏺' : '🎤'}
            </button>
            {s.sending ? (
              <button className="danger" onClick={() => void s.cancelChat()}>
                {L('Stop')}
              </button>
            ) : (
              <button className="primary" disabled={!draft.trim()} onClick={() => void onSend()}>
                {L('Send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
