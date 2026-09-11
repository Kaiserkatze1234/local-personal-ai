/**
 * First-start wizard — spec §71. Guides init → storage → provider discovery →
 * model selection → optional extras → permissions → resource mode. Optional
 * features are skippable; demo model always available so the app works from
 * step one even with nothing installed.
 */
import { type ReactElement, useState } from 'react';
import type { PermissionMode, ResourceMode } from '../../shared/types/capabilities.js';
import { L } from '../lib/i18n.js';
import { useStore } from '../state/store.js';

export function FirstRunWizard(): ReactElement {
  const s = useStore();
  const [step, setStep] = useState(0);
  const [permMode, setPermMode] = useState<PermissionMode>('BALANCED');
  const [resMode, setResMode] = useState<ResourceMode>('BALANCED');
  const [useDemo, setUseDemo] = useState(false);

  const providers = s.providers.filter((p) => p.kind !== 'mock');
  const healthy = providers.filter((p) => p.health.state === 'OK');
  const chatModels = s.models.filter((m) => m.capabilities.includes('text_generation'));
  const steps = 5;

  const finish = async (): Promise<void> => {
    s.patchConfig({ tools: { permissionMode: permMode }, performance: { mode: resMode } });
    await s.setResourceMode(resMode);
    if (useDemo) {
      const demo = s.providers.find((p) => p.kind === 'mock');
      const m = demo?.models[0];
      if (m) for (const role of ['chat', 'coding', 'planning']) await s.setRole(role, m.id);
    }
    await s.completeWizard();
  };

  const next = (): void => {
    if (step === 1) void s.refreshProviders();
    if (step === 2 && !useDemo && healthy.length === 0) {
      setUseDemo(true); // nothing else available — bind demo, say so plainly
    }
    setStep(step + 1);
  };

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-steps">
          {Array.from({ length: steps }).map((_, i) => (
            <span key={i} className={i < step ? 'done' : ''} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h2 style={{ marginTop: 0 }}>{L('Welcome — everything stays on this machine')}</h2>
            <p className="muted">
              Local Personal AI runs with a runtime model you choose (Ollama or any local OpenAI-compatible server). Data lives in:{' '}
              <span className="mono">{s.info?.dataDir}</span>
            </p>
            <ul className="muted">
              <li>{L('No cloud account, no telemetry.')}</li>
              <li>{L('File access starts empty — you grant folders explicitly.')}</li>
              <li>{L('You can change all of this in Settings later.')}</li>
            </ul>
          </>
        )}

        {step === 1 && (
          <>
            <h2 style={{ marginTop: 0 }}>{L('Local model provider')}</h2>
            {healthy.length > 0 ? (
              <div className="card">
                {healthy.map((p) => (
                  <div key={p.id} className="row" style={{ marginBottom: 4 }}>
                    <span className="dot ok" /> <b className="grow">{p.label}</b>{' '}
                    <span className="small muted">{p.models.length} model(s)</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card">
                <b>No provider detected.</b>
                <p className="small muted">
                  Install/start Ollama (ollama.com) and pull a model like <span className="mono">qwen2.5-coder:7b</span> for coding work,
                  then click Re-scan. You can continue with the built-in demo model to explore the UI — it is explicitly labeled and not a
                  real reasoning model.
                </p>
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => void s.refreshProviders()}>{L('Re-scan')}</button>
                  <label className="check">
                    <input type="checkbox" checked={useDemo} onChange={(e) => setUseDemo(e.target.checked)} /> use demo model for now
                  </label>
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={{ marginTop: 0 }}>{L('Runtime model selection')}</h2>
            {useDemo ? (
              <p className="muted">
                Demo model will be bound to all roles. Swap any time in Settings → AI; this is not a permanent choice.
              </p>
            ) : chatModels.length === 0 ? (
              <p className="muted">No chat-capable models found — go back and re-scan, or enable the demo model.</p>
            ) : (
              <div className="kv">
                {(['chat', 'coding'] as const).map((role) => (
                  <label key={role} className="field">
                    <span>{role} model</span>
                    <select
                      value={s.roles.find((r) => r.role === role)?.modelId ?? chatModels[0]?.id ?? ''}
                      onChange={(e) => void s.setRole(role, e.target.value)}
                    >
                      {chatModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} {m.parameterCountB ? `(${m.parameterCountB}B)` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <p className="small muted">
              Vision and voice are optional and detected later on the health screen — nothing is promised that your models can't do.
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <h2 style={{ marginTop: 0 }}>{L('Permissions')}</h2>
            <div className="card">
              {(['SAFE', 'BALANCED', 'ADVANCED'] as PermissionMode[]).map((m) => (
                <label key={m} className="check" style={{ marginBottom: 6 }}>
                  <input type="radio" name="perm" checked={permMode === m} onChange={() => setPermMode(m)} /> <b>{m}</b>&nbsp;
                  <span className="muted small">
                    {m === 'SAFE'
                      ? 'read-only default, confirm every change'
                      : m === 'BALANCED'
                        ? 'normal operations, confirm sensitive ones'
                        : 'broad automation; dangerous ops still require explicit approval'}
                  </span>
                </label>
              ))}
            </div>
            <p className="small muted">You can grant folders under Settings → Tools and at every confirmation dialog.</p>
          </>
        )}

        {step === 4 && (
          <>
            <h2 style={{ marginTop: 0 }}>{L('Performance profile')}</h2>
            <div className="card">
              {(['LOW_RESOURCE', 'BALANCED', 'PERFORMANCE'] as ResourceMode[]).map((m) => (
                <label key={m} className="check" style={{ marginBottom: 6 }}>
                  <input type="radio" name="res" checked={resMode === m} onChange={() => setResMode(m)} /> <b>{m}</b>{' '}
                  <span className="muted small">
                    {m === 'LOW_RESOURCE'
                      ? 'lightest: smaller models, paused background work'
                      : m === 'BALANCED'
                        ? 'recommended on laptops'
                        : 'use what the machine has'}
                  </span>
                </label>
              ))}
            </div>
            <p className="small muted">Auto-switching stays enabled: the app steps down under pressure regardless.</p>
          </>
        )}

        <div className="row" style={{ marginTop: 20, justifyContent: 'space-between' }}>
          <button className="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
            ← {L('Back')}
          </button>
          {step < steps - 1 ? (
            <button className="primary" onClick={next}>
              {L('Continue →')}
            </button>
          ) : (
            <button className="primary" onClick={() => void finish()}>
              {L('Start using the app')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
