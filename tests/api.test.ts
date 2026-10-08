/**
 * IPC-level integration: exercises the exact handler map the Electron
 * preload calls, end to end (chat persisted, wizard, health, memory).
 */
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { makeTestApp } from './helpers.js';

describe('api facade', () => {
  it('app.info + config round trip', async () => {
    const t = await makeTestApp();
    try {
      const api = new Api(t.app);
      const info = await api.handleRaw('app.info', []);
      expect(info.ok).toBe(true);
      if (!info.ok) return;
      expect((info.data as { platform: string }).platform).toBe(process.platform);
      const patched = await api.handleRaw('config.set', [{ general: { theme: 'light' } }]);
      expect(patched.ok && (patched.data as { general: { theme: string } }).general.theme).toBe('light');
      const bad = await api.handleRaw('nonexistent.method', []);
      expect(!bad.ok && bad.error?.kind).toBe('not_implemented');
    } finally {
      await t.cleanup();
    }
  });

  it('chat.send in CHAT mode persists both sides of the conversation', async () => {
    const t = await makeTestApp({ turns: ['hello from the model'] });
    try {
      const api = new Api(t.app);
      const res = await api.handleRaw('chat.send', [{ text: 'hi there', mode: 'CHAT' }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const cid = (res.data as { conversationId: string }).conversationId;
      const msgs = await api.handleRaw('conversations.messages', [cid]);
      expect(msgs.ok).toBe(true);
      const list = (msgs as { data: { role: string; content: string }[] }).data;
      expect(list.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(list[1]?.content).toContain('hello from the model');
      // and it went through the provider abstraction only:
      expect(t.mock.requests).toHaveLength(1);
      const convos = (await api.handleRaw('conversations.list', [])) as { data: { id: string }[] };
      expect(convos.data.some((c) => c.id === cid)).toBe(true);
      const search = (await api.handleRaw('conversations.search', ['model'])) as { data: unknown[] };
      expect(search.data.length).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('memory + skills + diagnostics via api', async () => {
    const t = await makeTestApp();
    try {
      const api = new Api(t.app);
      const add = await api.handleRaw('memory.add', ['I always want concise answers', 'preference']);
      expect(add.ok).toBe(true);
      const list = (await api.handleRaw('memory.list', [])) as { data: { id: string; status: string }[] };
      expect(list.data.length).toBe(1);
      expect(list.data[0]?.status).toBe('stored'); // explicit user additions are auto-confirmed (the "Remember this" path)
      const confirm = await api.handleRaw('memory.confirm', [list.data[0]!.id]);
      expect(confirm.ok).toBe(true);
      const health = (await api.handleRaw('diagnostics.health', [])) as {
        data: { overall: string; components: { id: string; state: string }[] };
      };
      expect(['OK', 'WARNING']).toContain(health.data.overall);
      expect(health.data.components.some((c) => c.id === 'storage.db' && c.state === 'OK')).toBe(true);
      expect(health.data.components.some((c) => c.id === 'provider.mock' && c.state === 'OK')).toBe(true);
      const self = (await api.handleRaw('diagnostics.selfTest', [])) as { data: { components: { id: string; state: string }[] } };
      expect(self.data.components.filter((c) => c.id.startsWith('selftest.')).every((c) => c.state === 'OK')).toBe(true);
      const ex = (await api.handleRaw('diagnostics.export', [])) as { data: { path: string } };
      expect(ex.data.path).toContain('diagnostics-');
      const wizard = await api.handleRaw('wizard.complete', []);
      expect(wizard.ok).toBe(true);
      const cfg = (await api.handleRaw('config.get', [])) as { data: { wizard: { completed: boolean } } };
      expect(cfg.data.wizard.completed).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('providers.list exposes health without any hard-coded provider (§6)', async () => {
    const t = await makeTestApp();
    try {
      const api = new Api(t.app);
      const r = (await api.handleRaw('providers.list', [])) as { data: { id: string; health: { state: string }; models: unknown[] }[] };
      expect(r.data.length).toBe(1);
      expect(r.data[0]?.id).toBe('mock');
      expect(r.data[0]?.health.state).toBe('OK');
      expect(r.data[0]?.models.length ?? 0).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});
