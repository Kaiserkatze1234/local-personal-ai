/** Fourth pass: German UI layer, startup behaviour (§47), extension UI panels/providers (§42), diagnostics endpoints (§50/§52). */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { tr } from '../src/shared/i18n.js';
import { nowIso } from '../src/shared/types/common.js';
import type { ModelInfo, ModelProviderAdapter, ProviderHealth } from '../src/shared/types/models.js';
import { makeTestApp } from './helpers.js';

describe('German UI layer (§47 language)', () => {
  it('translates known chrome keys for de, passes through for en and unknown keys', () => {
    expect(tr('de', 'Settings')).toBe('Einstellungen');
    expect(tr('de', 'Permission needed')).toBe('Berechtigung erforderlich');
    expect(tr('de-DE', 'Send')).toBe('Senden');
    expect(tr('en', 'Settings')).toBe('Settings');
    expect(tr('de', 'totally unknown string')).toBe('totally unknown string'); // graceful fallback
  });
});

describe('startup behaviour config (§47)', () => {
  it('round-trips autostart/startHidden/closeToTray through the persisted config', async () => {
    const t = await makeTestApp();
    try {
      expect(t.app.getConfig().general.autostart).toBe(false);
      expect(t.app.getConfig().general.closeToTray).toBe(true); // sane default: close hides to tray when tray exists
      t.app.config.patch({ general: { autostart: true, startHidden: true } });
      const fresh = t.app.getConfig().general;
      expect(fresh.autostart).toBe(true);
      expect(fresh.startHidden).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

const tinyAdapter: ModelProviderAdapter = {
  id: 'extvoice',
  label: 'Extension voice slot',
  async discoverModels(): Promise<ModelInfo[]> {
    return [{ id: 'extvoice:dummy', providerId: 'extvoice', name: 'dummy', contextLength: 0, capabilities: ['audio_input'] }];
  },
  async healthCheck(): Promise<ProviderHealth> {
    return { providerId: 'extvoice', state: 'OK', message: 'stub', checkedAt: nowIso() };
  },
};

describe('extension UI panels + provider contributions (§42)', () => {
  it('an activated extension adds a sidebar panel and a provider; uninstall removes both', async () => {
    const t = await makeTestApp({ writeScope: true });
    const api = new Api(t.app);
    try {
      const dir = join(t.dir, 'exts', 'helperext');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          id: 'helperext',
          name: 'Helper',
          version: '2.0.0',
          capabilities: ['tool', 'provider'],
          permissions: [],
          dependencies: [],
        }),
      );
      writeFileSync(
        join(dir, 'main.mjs'),
        `export default (ctx) => {
           ctx.addPanel({ id: 'info', title: 'Helper Status', markdown: 'Alles gut — Helper Extension läuft.' });
         }`,
      );
      const r = await t.app.extensions.loadFromDirectory(join(t.dir, 'exts'));
      expect(r.loaded).toEqual(['helperext']);
      const panels = await api.handleRaw('extensions.panels', []);
      expect(panels.ok).toBe(true);
      if (panels.ok) {
        const list = panels.data as { id: string; title: string; markdown: string }[];
        expect(list.some((p) => p.id === 'helperext:info' && p.markdown.includes('Helper Extension läuft'))).toBe(true);
      }
      // provider contribution works through the same ctx (programmatic install path)
      t.app.extensions.install(
        { id: 'voiceext', name: 'Voice Ext', version: '1.0.0', capabilities: ['provider'], permissions: [], dependencies: [] },
        (ctx) => {
          ctx.addModelProvider(tinyAdapter);
        },
      );
      expect(t.app.providers.list().some((p) => p.id === 'extvoice')).toBe(true);
      await t.app.providers.refreshProvider('extvoice');
      const models = t.app.providers.allModels().find((m) => m.id === 'extvoice:dummy');
      expect(models).toBeTruthy();

      t.app.extensions.uninstall('voiceext');
      expect(t.app.providers.list().some((p) => p.id === 'extvoice')).toBe(false);
      expect(t.app.extensions.uninstall('helperext')).toBe(true);
      const after = await api.handleRaw('extensions.panels', []);
      if (after.ok) expect((after.data as unknown[]).length).toBe(0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('diagnostics endpoints (§50/§52)', () => {
  it('logs tail returns the written log; reveal is honest without the shell', async () => {
    const t = await makeTestApp();
    const api = new Api(t.app);
    try {
      t.app.log.child('test').info('probe-line-unique-42');
      const res = await api.handleRaw('diagnostics.logs', [50]);
      expect(res.ok).toBe(true);
      if (res.ok) expect(String((res.data as { text: string }).text)).toContain('probe-line-unique-42');

      const rev = await api.handleRaw('diagnostics.reveal', ['/whatever']);
      expect(rev.ok && (rev.data as { ok: boolean }).ok).toBe(false); // no host.reveal in tests — reported, not faked
    } finally {
      await t.cleanup();
    }
  });
});
