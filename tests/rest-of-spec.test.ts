/** Coverage for the second build pass: §49 internet, §42 extensions, §24 voice API, §56 idle unload, §15 repair loop, §21 region capture. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { CoreApp } from '../src/main/app.js';
import { ingestFile } from '../src/main/files/importers.js';
import type { ScreenSource } from '../src/main/vision/visionService.js';
import { makeTestApp } from './helpers.js';

describe('internet layer (§49)', () => {
  it('is off by default and says so — tools exist but refuse', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [], write: [] }), cwd: () => undefined };
      const r = await t.app.tools.call('http_get', { url: 'https://example.com' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('disabled');
    } finally {
      await t.cleanup();
    }
  });

  it('fetches (capped, html-stripped) when enabled; respects host allowlist', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' }, internet: { enabled: true, maxResponseKB: 8 } } });
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<html><body><p>the answer is forty-two</p><script>evil()</script>${'x'.repeat(50_000)}</body></html>`);
    });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [], write: [] }), cwd: () => undefined };
      const r = await t.app.tools.call('http_get', { url: `http://127.0.0.1:${port}/doc` }, ctx);
      expect(r.ok).toBe(true);
      const data = r.data as { content: string; truncated?: boolean };
      expect(data.content).toContain('forty-two');
      expect(data.content).not.toContain('evil()');
      expect(data.truncated).toBe(true); // 8KB cap applied

      t.app.config.patch({ internet: { allowedHosts: ['docs.python.org'] } });
      const blocked = await t.app.tools.call('http_get', { url: `http://127.0.0.1:${port}/doc` }, ctx);
      expect(blocked.ok).toBe(false);
      expect(blocked.summary).toContain('allowlist');
    } finally {
      server.close();
      await t.cleanup();
    }
  });
});

describe('extension registry (§42)', () => {
  const manifest: import('../src/main/extensions/extensionRegistry.js').ExtensionManifest = {
    id: 'wordcount',
    name: 'Word Counter',
    version: '1.0.0',
    description: 'counts words in a file',
    capabilities: ['tool'],
    permissions: ['fs.read'],
    dependencies: [],
  };

  it('validates manifests and rejects dependency violations', async () => {
    const t = await makeTestApp();
    try {
      expect(() => t.app.extensions.install({ ...manifest, id: 'BAD ID!' }, () => undefined)).toThrow(/manifest invalid/i);
      expect(() => t.app.extensions.install({ ...manifest, version: 'banana' }, () => undefined)).toThrow(/version/i);
      expect(() => t.app.extensions.install({ ...manifest, dependencies: ['ghost'] }, () => undefined)).toThrow(/requires "ghost"/);
    } finally {
      await t.cleanup();
    }
  });

  it('activated extension contributes a namespaced tool and an importer; uninstall removes both', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      const dir = t.dir;
      const st = await t.app.extensions.install(manifest, (ctx) => {
        ctx.addTool({
          name: 'count',
          description: 'count words in a granted file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          permission: 'fs.read',
          mutating: false,
          run: async (input, toolCtx) => {
            const res = await t.app.tools.call('read_file', { path: input.path }, toolCtx);
            const text = String((res.data as { text?: string })?.text ?? '');
            return { ok: true, summary: `${text.split(/\s+/).filter(Boolean).length} words` };
          },
        });
        ctx.addImporter({
          id: 'wordcount:wtext',
          detect: (ext) => ext === '.wtext',
          ingest: (p) => ({
            ok: true,
            kind: 'wtext',
            metadata: { name: p, sizeBytes: 1, ext: '.wtext', mtimeMs: 0 },
            text: 'custom-parsed',
            chunks: [],
          }),
        });
        return () => undefined; // dispose hook
      });
      expect(st.active).toBe(true);
      expect(st.contributedTools).toEqual(['wordcount_count']);

      writeFileSync(join(dir, 'a.txt'), 'one two three four');
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [dir], write: [dir] }), cwd: () => dir };
      const r = await t.app.tools.call('wordcount_count', { path: 'a.txt' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.summary).toContain('4 words');

      // contributed importer is used by the ingestion pipeline
      writeFileSync(join(dir, 'b.wtext'), 'whatever');
      expect(ingestFile(join(dir, 'b.wtext')).text).toBe('custom-parsed');

      expect(t.app.extensions.uninstall('wordcount')).toBe(true);
      expect(t.app.tools.listManifests().some((m) => m.name === 'wordcount_count')).toBe(false);
      expect(ingestFile(join(dir, 'b.wtext')).kind).not.toBe('wtext');
    } finally {
      await t.cleanup();
    }
  });

  it('manifest must declare the permission its tool uses (no privilege creep)', async () => {
    const t = await makeTestApp();
    try {
      expect(() =>
        t.app.extensions.install(manifest, (ctx) => {
          ctx.addTool({
            name: 'sneaky',
            description: 'writes without declaring fs.write',
            inputSchema: { type: 'object' },
            permission: 'fs.write',
            mutating: true,
            run: async () => ({ ok: true, summary: 'nope' }),
          });
        }),
      ).toThrow(/does not declare/);
    } finally {
      await t.cleanup();
    }
  });
});

describe('voice pipeline (§24)', () => {
  it('transcribe + speak go through role-bound providers; honest when unbound', async () => {
    const t = await makeTestApp();
    const api = new Api(t.app);
    try {
      const noBind = await api.handleRaw('voice.transcribe', ['aGVsbG8=', 'audio/webm']);
      expect(!noBind.ok).toBe(true); // STT role unbound + voice disabled default -> honest failure

      t.app.config.patch({ voice: { enabled: true } });
      const stillNoBackend = await api.handleRaw('voice.transcribe', ['aGVsbG8=', 'audio/webm']);
      expect(!stillNoBackend.ok).toBe(true);
      if (!stillNoBackend.ok) expect(stillNoBackend.error?.message).toContain('speech-to-text');

      const modelId = t.app.providers.allModels().find((m) => m.providerId === 'mock')!.id;
      t.app.roles.set('stt', modelId);
      t.app.roles.set('tts', modelId);
      t.mock.pushTranscript('turn the lights down');
      const tr = await api.handleRaw('voice.transcribe', [Buffer.from('fakeaudio').toString('base64'), 'audio/webm']);
      expect(tr.ok && (tr.data as { text: string }).text).toBe('turn the lights down');

      const sp = await api.handleRaw('voice.speak', ['hello out there']);
      expect(sp.ok).toBe(true);
      if (sp.ok) {
        const decoded = Buffer.from((sp.data as { audioBase64: string }).audioBase64, 'base64').toString();
        expect(decoded).toContain('demo-audio:hello out there');
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe('idle model unload (§56)', () => {
  it('tracks usage and asks the provider to drop resident models when idle', async () => {
    const t = await makeTestApp();
    try {
      const modelId = t.app.providers.allModels().find((m) => m.providerId === 'mock')!.id;
      t.app.providers.chatFor(modelId); // mark used
      expect(await t.app.providers.unloadIdle(0)).toEqual([]); // 0 = feature off
      // time-travel: make "used" 2 minutes ago, then unload after 1 idle minute
      const t0 = Date.now();
      const realNow = Date.now;
      Date.now = () => t0 + 120_000;
      try {
        const unloaded = await t.app.providers.unloadIdle(1);
        expect(unloaded).toContain(modelId);
      } finally {
        Date.now = realNow;
      }
      expect(t.mock.unloadCalls).toContain(modelId);
    } finally {
      await t.cleanup();
    }
  });
});

describe('bounded repair loop (§15)', () => {
  it('failed verification triggers exactly one repair pass, then re-verifies', async () => {
    const t = await makeTestApp({
      writeScope: true,
      config: { tools: { permissionMode: 'ADVANCED' } },
      turns: [
        { text: 'writing data.txt', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'data.txt', content: 'broken' } }] },
        { text: 'done on first pass' },
        { text: 'fixing', toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'data.txt', content: 'fixed by repair' } }] },
        { text: 'repaired and should pass now' },
      ],
    });
    try {
      // project whose verification script fails once, passes after any change
      const projDir = join(t.dir, 'proj');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'package.json'), JSON.stringify({ name: 'proj', scripts: { test: 'node verify.js' } }));
      writeFileSync(
        join(projDir, 'verify.js'),
        `const fs=require('fs');let n=0;try{n=+fs.readFileSync('count.txt','utf8')}catch{};fs.writeFileSync('count.txt',String(n+1));process.exit(n>=1?0:1);`,
      );
      const proj = await t.app.projects.addProject(projDir);
      // force the project's verification command to the raw node script (skip npm for test speed)
      const rows = t.app.store.all<{ id: string; json: string }>(`SELECT id, json FROM projects`);
      const row = rows.find((r) => r.id === proj.id);
      if (row) {
        const info = JSON.parse(row.json);
        info.testCommands = ['node verify.js'];
        t.app.store.run(`UPDATE projects SET json=? WHERE id=?`, JSON.stringify(info), row.id);
      }

      const out = await t.app.agent.run({ userText: 'make the test pass in the project', mode: 'CODING', projectId: proj.id });
      expect(out.task.status).toBe('completed');
      expect(out.finalText).toContain('bounded repair attempt');
      expect(out.finalText).toContain('[verification] passed');
      expect(t.mock.requests.length).toBe(3); // initial, no-more-tools answer, repair pass
    } finally {
      await t.cleanup();
    }
  });
});

describe('region capture (§21)', () => {
  it('passes a rect through to the screen source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-rect-'));
    try {
      let gotRect: unknown = 'unset';
      const screen: ScreenSource = {
        available: () => true,
        capture: async (opts) => {
          gotRect = opts?.rect ?? null;
          return { mimeType: 'image/png', dataBase64: 'AAAA' };
        },
      };
      const app = new CoreApp({ dataDir: dir, adapters: 'mock-only', timers: false, host: { screenSource: screen } });
      await app.boot();
      try {
        const shot = await app.vision.captureScreen({ x: 10, y: 20, width: 300, height: 200 });
        expect(shot.mimeType).toBe('image/png');
        expect(gotRect).toEqual({ x: 10, y: 20, width: 300, height: 200 });
        const full = await app.vision.captureScreen();
        expect(full.dataBase64).toBe('AAAA');
      } finally {
        await app.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
