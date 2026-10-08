import { type ReactElement, useEffect, useState } from 'react';
import type { AppMode } from '../shared/types/capabilities.js';
import { ChatPanel } from './components/ChatPanel.js';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.js';
import { FirstRunWizard } from './components/FirstRunWizard.js';
import { MemoryPanel } from './components/MemoryPanel.js';
import { Notices } from './components/Notices.js';
import { PermissionDialog } from './components/PermissionDialog.js';
import { ProjectsPanel } from './components/ProjectsPanel.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { SkillsPanel } from './components/SkillsPanel.js';
import { TasksPanel } from './components/TasksPanel.js';
import { L } from './lib/i18n.js';
import { useStore } from './state/store.js';

type Panel = 'chat' | 'tasks' | 'projects' | 'memory' | 'skills' | 'settings' | 'diagnostics' | (string & {});

const MODES: { id: AppMode; label: string; title: string }[] = [
  { id: 'CHAT', label: 'Chat', title: 'Conversation — uses your runtime model directly' },
  { id: 'AGENT', label: 'Agent', title: 'Multi-step task execution with approved tools' },
  { id: 'CODING', label: 'Coding', title: 'Project-aware: inspect → edit → verify' },
  { id: 'ASSISTANT', label: 'Assistant', title: 'Computer assistance on scoped folders' },
];

export function App(): ReactElement {
  const s = useStore();
  const [panel, setPanel] = useState<Panel>('chat');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void s.init();
  }, []);

  // §62: dropping a file anywhere imports it — same route "Öffnen mit" takes.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (ev: DragEvent): boolean => Boolean(ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files'));
    const onDragOver = (ev: DragEvent): void => {
      if (hasFiles(ev)) ev.preventDefault();
    };
    const onDragEnter = (ev: DragEvent): void => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth += 1;
      setDragOver(true);
    };
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onDrop = (ev: DragEvent): void => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = ev.dataTransfer?.files;
      if (files && files.length > 0) void useStore.getState().openDropped(files);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    if (s.connected) void s.loadSidePanels();
  }, [s.connected]);

  if (!s.connected) {
    return (
      <div className="app" style={{ placeItems: 'center' }}>
        <div className="empty-chat">
          <h1>Local Personal AI</h1>
          <div className="hint">
            {s.error ?? 'Connecting to the local core…'}
            <div style={{ marginTop: 12 }}>
              <button onClick={() => void s.init()}>{L('Retry')}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (s.config && !s.config.wizard.completed) return <FirstRunWizard />;

  const pendingPerms = s.permissionQueue.length;
  const activeTasks = s.tasks.filter((t) =>
    ['executing', 'analyzing', 'verifying', 'queued', 'waiting_for_permission'].includes(t.status),
  ).length;
  const demoOnly = s.providers.every((p) => p.kind === 'mock');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">λ</div>
          Local AI
        </div>
        {(
          [
            ['chat', 'Chat', 0],
            ['tasks', 'Tasks', activeTasks],
            ['projects', 'Projects', 0],
            ['memory', 'Memory', s.memory.filter((m) => m.status === 'candidate').length],
            ['skills', 'Skills', 0],
            ['diagnostics', 'Diagnostics', 0],
            ['settings', 'Settings', 0],
            ...s.extensionPanels.map((pr) => [`ext:${pr.id}`, pr.title, 0] as [Panel, string, number]),
          ] as [Panel, string, number][]
        ).map(([id, label, badge]) => (
          <button key={id} className={`nav-item ${panel === id ? 'active' : ''}`} onClick={() => setPanel(id)}>
            <span>{L(label)}</span>
            {badge > 0 && <span className="nav-badge">{badge}</span>}
          </button>
        ))}
        <div className="foot">
          <div className="status-row">
            <span className={`dot ${demoOnly ? 'warn' : 'ok'}`} />
            <span>{L(demoOnly ? 'demo model only' : 'runtime model bound')}</span>
          </div>
          <div className="muted small">{s.info?.version} · local-first</div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="seg" role="tablist">
            {MODES.map((m) => (
              <button key={m.id} title={L(m.title)} className={s.mode === m.id ? 'on' : ''} onClick={() => s.setMode(m.id)}>
                {L(m.label)}
              </button>
            ))}
          </div>
          <select
            className="chip"
            title="Active project (used by Coding/Agent modes)"
            value={s.activeProjectId ?? ''}
            onChange={(e) => s.setProject(e.target.value || null)}
          >
            <option value="">{L('No project')}</option>
            {s.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="spacer" />
          {s.sending && <span className="chip on">{L('working…')}</span>}
          {pendingPerms > 0 && (
            <span className="chip" style={{ borderColor: 'var(--warn)' }}>
              ⚠ {pendingPerms} permission{pendingPerms > 1 ? 's' : ''}
            </span>
          )}
          <button className="ghost" title="New conversation" onClick={() => s.newChat()}>
            ＋ New
          </button>
        </div>

        <div className="content">
          {panel === 'chat' && <ChatPanel />}
          {panel === 'tasks' && <TasksPanel />}
          {panel === 'projects' && <ProjectsPanel />}
          {panel === 'memory' && <MemoryPanel />}
          {panel === 'skills' && <SkillsPanel />}
          {panel === 'settings' && <SettingsPanel />}
          {panel === 'diagnostics' && <DiagnosticsPanel />}
          {panel.startsWith('ext:') && <ExtensionView id={panel.slice(4)} />}
        </div>
      </div>

      <PermissionDialog />
      <Notices />
      {dragOver && (
        <div className="dropveil">
          <div className="dropbox">
            <div style={{ fontSize: 26 }}>⇩</div>
            <div>{L('Drop files to import')}</div>
            <div className="muted small">{L('Text, Markdown, PDF, DOCX, code — the AI can use them afterwards')}</div>
          </div>
        </div>
      )}
      {s.error && (
        <div className="notices" style={{ top: 12, bottom: 'auto', right: 12 }}>
          <div className="notice" style={{ borderLeftColor: 'var(--err)' }}>
            <div>{s.error}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <button className="ghost" onClick={() => useStore.setState({ error: null })}>
                dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExtensionView({ id }: { id: string }): ReactElement {
  const s = useStore();
  const p = s.extensionPanels.find((x) => x.id === id);
  if (!p) return <div className="panel muted">{L('no extensions')}</div>;
  return (
    <div className="panel">
      <h2>{p.title}</h2>
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55 }}>{p.markdown}</pre>
    </div>
  );
}
