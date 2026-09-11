/**
 * Settings — §47 structure, §6/§7 model binding, §40 perf, §11 permissions.
 * Every control maps to a config path patched through the typed API.
 */
import { type ReactElement, useEffect, useState } from 'react';
import type { ModelRole, PermissionMode, ResourceMode } from '../../shared/types/capabilities.js';
import * as api from '../lib/api.js';
import { useStore } from '../state/store.js';

const ROLES: ModelRole[] = [
  'chat',
  'coding',
  'planning',
  'review',
  'vision',
  'embeddings',
  'compression',
  'prompt_assistant',
  'summarization',
  'stt',
  'tts',
];

function Field({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SettingsPanel(): ReactElement {
  const s = useStore();
  const cfg = s.config;
  const [roots, setRoots] = useState('');

  useEffect(() => {
    if (cfg) setRoots(cfg.tools.allowedRoots.join('\n'));
  }, [cfg?.tools.allowedRoots.length]);
  if (!cfg) return <div className="panel">Loading…</div>;

  const patch = (p: object): void => void s.patchConfig(p);
  const modelOptions = s.models;
  const boundFor = (role: string): string => s.roles.find((r) => r.role === role)?.modelId ?? '';

  return (
    <div className="panel">
      <h2>Settings</h2>
      <p className="sub">Stored locally in config.json. The runtime model is a choice, not a dependency — swap providers any time.</p>

      <div className="settings-grid">
        <div className="card">
          <h3>AI — providers</h3>
          {s.providers.map((p) => (
            <div key={p.id} className="row" style={{ marginBottom: 6 }}>
              <span className={`dot ${p.health.state === 'OK' ? 'ok' : p.health.state === 'WARNING' ? 'warn' : 'err'}`} />
              <b className="grow">{p.label}</b>
              <span className="small muted">
                {p.models.length} models · {p.health.state}
              </span>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void s.refreshProviders()}>Re-detect providers</button>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            Ollama is auto-detected on 127.0.0.1:11434. Extra OpenAI-compatible endpoint via env LPAI_OPENAI_BASE_URL — adapters are
            pluggable; the core never depends on one runtime.
          </div>
        </div>

        <div className="card">
          <h3>AI — model roles (routing)</h3>
          <div className="kv">
            {ROLES.map((role) => (
              <Field key={role} label={role.replace('_', ' ')}>
                <select
                  value={boundFor(role)}
                  onChange={(e) => {
                    void s.setRole(role, e.target.value || null);
                  }}
                >
                  <option value="">auto</option>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.providerId})
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <Field label="temperature">
            <input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={cfg.ai.temperature}
              onChange={(e) => patch({ ai: { temperature: Number(e.target.value) } })}
            />
          </Field>
          <div className="row" style={{ marginTop: 8 }}>
            <Field label="chat context (tokens)">
              <input
                type="number"
                value={cfg.ai.contextTokenBudget}
                onChange={(e) => patch({ ai: { contextTokenBudget: Number(e.target.value) } })}
              />
            </Field>
            <Field label="agent context (tokens)">
              <input
                type="number"
                value={cfg.ai.agentContextTokenBudget}
                onChange={(e) => patch({ ai: { agentContextTokenBudget: Number(e.target.value) } })}
              />
            </Field>
          </div>
        </div>

        <div className="card">
          <h3>Tools — permissions & scope</h3>
          <Field label="permission mode">
            <select
              value={cfg.tools.permissionMode}
              onChange={(e) => {
                patch({ tools: { permissionMode: e.target.value as PermissionMode } });
                void s.loadSidePanels();
              }}
            >
              <option value="SAFE">SAFE — read default, confirm changes</option>
              <option value="BALANCED">BALANCED — normal ops, confirm sensitive</option>
              <option value="ADVANCED">ADVANCED — broad automation, dangerous still gated</option>
            </select>
          </Field>
          <Field label="writable roots (one per line)">
            <textarea
              rows={3}
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
              onBlur={() =>
                patch({
                  tools: {
                    allowedRoots: roots
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
          <div className="row">
            <button
              onClick={async () => {
                // directory picker provided by the Electron host via projects.add path
                useStore.setState({ error: 'Use "Pick folder" in Projects to grant a scope folder.' });
              }}
            >
              Hint
            </button>
          </div>
          <Field label="command timeout (seconds)">
            <input
              type="number"
              value={cfg.tools.commandTimeoutSec}
              onChange={(e) => patch({ tools: { commandTimeoutSec: Number(e.target.value) } })}
            />
          </Field>
          {s.permissions && s.permissions.grants.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Persistent grants</h3>
              {s.permissions.grants.map((g) => (
                <div key={g.permission} className="row small">
                  <span className="mono grow">{g.permission}</span>
                  <span className={g.decision === 'allow' ? 'verify-ok' : 'verify-fail'}>{g.decision}</span>
                  <button
                    className="ghost"
                    onClick={() => {
                      void (async () => {
                        const { call } = await import('../lib/api.js');
                        await call('permissions.resetGrant', g.permission);
                        await s.loadSidePanels();
                      })();
                    }}
                  >
                    revoke
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <h3>Memory & learning</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.memory.enabled} onChange={(e) => patch({ memory: { enabled: e.target.checked } })} /> enable
            long-term memory
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.memory.requireReview}
              onChange={(e) => patch({ memory: { requireReview: e.target.checked } })}
            />{' '}
            new memories need my confirmation
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.memory.compressionEnabled}
              onChange={(e) => patch({ memory: { compressionEnabled: e.target.checked } })}
            />{' '}
            auto-compress / dedupe memory
          </label>
          <Field label="episode retention (days, 0 = keep)">
            <input
              type="number"
              value={cfg.memory.retentionDays}
              onChange={(e) => patch({ memory: { retentionDays: Number(e.target.value) } })}
            />
          </Field>
        </div>

        <div className="card">
          <h3>Vision / screen / voice</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.vision.enabled} onChange={(e) => patch({ vision: { enabled: e.target.checked } })} /> vision
            (screenshot analysis)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.vision.persistScreenshots}
              onChange={(e) => patch({ vision: { persistScreenshots: e.target.checked } })}
            />{' '}
            keep screenshots on disk (off = ephemeral)
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.voice.enabled} onChange={(e) => patch({ voice: { enabled: e.target.checked } })} /> voice
            I/O (requires STT/TTS provider)
          </label>
          <div className="row">
            <Field label="dictation hotkey">
              <input
                value={cfg.voice.pushToTalkHotkey}
                onChange={(e) => patch({ voice: { pushToTalkHotkey: e.target.value } })}
                placeholder="Ctrl+Alt+M"
              />
            </Field>
            <Field label={`speed ${cfg.voice.speed.toFixed(1)}x`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={cfg.voice.speed}
                onChange={(e) => patch({ voice: { speed: Number(e.target.value) } })}
              />
            </Field>
            <Field label={`volume ${Math.round(cfg.voice.volume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cfg.voice.volume}
                onChange={(e) => patch({ voice: { volume: Number(e.target.value) } })}
              />
            </Field>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            Unsupported capability = honest error, never a fake demo. Bind vision/stt/tts models above; record-analysis needs ffmpeg on
            PATH.
          </div>
        </div>

        <div className="card">
          <h3>Internet (optional layer — core never needs it)</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.internet.enabled} onChange={(e) => patch({ internet: { enabled: e.target.checked } })} />{' '}
            allow http_get / web_search tools
          </label>
          <Field label="allowed hosts (one per line; empty = any https)">
            <textarea
              rows={2}
              defaultValue={cfg.internet.allowedHosts.join('\n')}
              onBlur={(e) =>
                patch({
                  internet: {
                    allowedHosts: e.currentTarget.value
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
          <Field label="max response size (KB)">
            <input
              type="number"
              value={cfg.internet.maxResponseKB}
              onChange={(e) => patch({ internet: { maxResponseKB: Number(e.target.value) } })}
            />
          </Field>
          <div className="small muted" style={{ marginTop: 6 }}>
            Network calls still require the per-request permission (§11) — enabling the layer alone does not auto-approve fetches.
          </div>
        </div>

        <div className="card">
          <h3>Overlay & prompt assistant</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.overlay.enabled} onChange={(e) => patch({ overlay: { enabled: e.target.checked } })} />{' '}
            desktop overlay enabled
          </label>
          <div className="row">
            <button onClick={() => void s.toggleOverlay(true)}>Show overlay</button>
            <button onClick={() => void s.toggleOverlay(false)}>Hide overlay</button>
          </div>
          <div className="row">
            <Field label="position">
              <select
                value={cfg.overlay.position}
                onChange={(e) =>
                  patch({ overlay: { position: e.target.value as 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' } })
                }
              >
                <option value="top-right">top-right</option>
                <option value="top-left">top-left</option>
                <option value="bottom-right">bottom-right</option>
                <option value="bottom-left">bottom-left</option>
              </select>
            </Field>
            <Field label={`opacity ${Math.round(cfg.overlay.opacity * 100)}%`}>
              <input
                type="range"
                min={0.35}
                max={1}
                step={0.05}
                value={cfg.overlay.opacity}
                onChange={(e) => patch({ overlay: { opacity: Number(e.target.value) } })}
              />
            </Field>
          </div>
          <Field label="hotkey (toggle overlay)">
            <input value={cfg.overlay.hotkey} onChange={(e) => patch({ overlay: { hotkey: e.target.value } })} placeholder="Ctrl+Alt+O" />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.overlay.lowResourceMode}
              onChange={(e) => patch({ overlay: { lowResourceMode: e.target.checked } })}
            />{' '}
            gaming mode: click-through, display-only, never takes focus
          </label>
          <label className="check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={cfg.promptAssistant.enabled}
              onChange={(e) => patch({ promptAssistant: { enabled: e.target.checked } })}
            />{' '}
            prompt assistant (while typing)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.promptAssistant.useModel}
              onChange={(e) => patch({ promptAssistant: { useModel: e.target.checked } })}
            />{' '}
            allow small model pass (debounced)
          </label>
        </div>

        <div className="card">
          <h3>Performance</h3>
          <Field label="resource mode">
            <select
              value={cfg.performance.mode}
              onChange={(e) => {
                void s.setResourceMode(e.target.value as ResourceMode);
              }}
            >
              <option value="LOW_RESOURCE">LOW_RESOURCE</option>
              <option value="BALANCED">BALANCED</option>
              <option value="PERFORMANCE">PERFORMANCE</option>
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.performance.autoSwitch}
              onChange={(e) => patch({ performance: { autoSwitch: e.target.checked } })}
            />{' '}
            auto-switch under pressure
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.performance.pauseIndexingDuringGeneration}
              onChange={(e) => patch({ performance: { pauseIndexingDuringGeneration: e.target.checked } })}
            />{' '}
            pause indexing while generating
          </label>
          <Field label="background concurrency (1-4)">
            <input
              type="number"
              min={1}
              max={4}
              value={cfg.performance.backgroundConcurrency}
              onChange={(e) => patch({ performance: { backgroundConcurrency: Number(e.target.value) } })}
            />
          </Field>
          <Field label="unload idle models after (minutes, 0=never)">
            <input
              type="number"
              min={0}
              value={cfg.performance.modelIdleUnloadMinutes}
              onChange={(e) => patch({ performance: { modelIdleUnloadMinutes: Number(e.target.value) } })}
            />
          </Field>
        </div>

        <div className="card">
          <h3>Proactive & personality</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.proactive.enabled} onChange={(e) => patch({ proactive: { enabled: e.target.checked } })} />{' '}
            proactive help (strong reasons only)
          </label>
          <Field label="min confidence">
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={cfg.proactive.minConfidence}
              onChange={(e) => patch({ proactive: { minConfidence: Number(e.target.value) } })}
            />
          </Field>
          <div className="row">
            <Field label="verbosity">
              <select
                value={cfg.personality.verbosity}
                onChange={(e) => patch({ personality: { verbosity: e.target.value as 'concise' | 'balanced' | 'detailed' } })}
              >
                <option>concise</option>
                <option>balanced</option>
                <option>detailed</option>
              </select>
            </Field>
            <Field label="formality">
              <select
                value={cfg.personality.formality}
                onChange={(e) => patch({ personality: { formality: e.target.value as 'formal' | 'casual' } })}
              >
                <option>formal</option>
                <option>casual</option>
              </select>
            </Field>
            <Field label="depth">
              <select
                value={cfg.personality.technicalDepth}
                onChange={(e) => patch({ personality: { technicalDepth: e.target.value as 'simple' | 'standard' | 'deep' } })}
              >
                <option>simple</option>
                <option>standard</option>
                <option>deep</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="card">
          <h3>Indexing (§31 — opt-in only)</h3>
          <label className="check">
            <input type="checkbox" checked={cfg.indexing.enabled} onChange={(e) => patch({ indexing: { enabled: e.target.checked } })} />{' '}
            global metadata file index
          </label>
          <Field label="indexed roots (one per line)">
            <textarea
              rows={3}
              defaultValue={cfg.indexing.roots.join('\n')}
              onBlur={(e) =>
                patch({
                  indexing: {
                    roots: e.currentTarget.value
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
          <div className="small muted">
            Never auto-scans your whole drive. Excludes, pause, remove and rebuild are available; rebuild applies on patch.
          </div>
        </div>

        <div className="card">
          <h3>Extensions (modular capabilities, §42)</h3>
          <ExtensionsCard />
        </div>

        <div className="card">
          <h3>General</h3>
          <Field label="language (UI strings will follow this)">
            <select value={cfg.general.language} onChange={(e) => patch({ general: { language: e.target.value } })}>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label="log level">
            <select
              value={cfg.diagnostics.logLevel}
              onChange={(e) => patch({ diagnostics: { logLevel: e.target.value as 'debug' | 'info' | 'warn' | 'error' } })}
            >
              <option>debug</option>
              <option>info</option>
              <option>warn</option>
              <option>error</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

interface ExtRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  active: boolean;
  error?: string;
  contributedTools: string[];
}

function ExtensionsCard(): ReactElement {
  const [rows, setRows] = useState<ExtRow[]>([]);
  const load = (): void =>
    void (async () => {
      try {
        setRows(await api.call('extensions.list'));
      } catch {
        /* bridge unavailable in plain-browser dev */
      }
    })();
  useEffect(() => {
    load();
  }, []);
  if (rows.length === 0)
    return (
      <div className="small muted">
        No extensions installed. Extensions are modules with a manifest (capabilities, permissions, dependencies); they can contribute tools
        and importers without touching the core.
      </div>
    );
  return (
    <>
      {rows.map((r) => (
        <div key={r.id} className="row" style={{ marginBottom: 4 }}>
          <b>
            {r.name} <span className="status-pill">v{r.version}</span>
          </b>
          <span className="small muted grow">
            {r.description}{' '}
            {r.contributedTools.length > 0 && (
              <>
                · tools: <span className="mono">{r.contributedTools.join(', ')}</span>
              </>
            )}
          </span>
          <span className={r.active ? 'verify-ok' : 'verify-fail'} style={{ fontSize: 11 }}>
            {r.active ? 'active' : (r.error ?? 'inactive')}
          </span>
          <button
            className="ghost"
            onClick={async () => {
              await api.call('extensions.uninstall', r.id);
              load();
            }}
          >
            remove
          </button>
        </div>
      ))}
    </>
  );
}
