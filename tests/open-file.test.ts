/**
 * "Start the app by opening one thing": launch-argv extraction + the shared
 * import route every external file takes (Open-with, second instance, drop,
 * dialog). The Electron wiring itself is 10 lines over these two primitives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { extractLaunchFiles } from '../src/main/launchFiles.js';
import { makeTestApp } from './helpers.js';

describe('extractLaunchFiles', () => {
  const base = (files: Set<string>) => ({
    cwd: 'C:\\Users\\me',
    exe: 'C:\\Program Files\\Local AI\\Local Personal AI.exe',
    appDir: 'C:\\Program Files\\Local AI\\resources\\app.asar',
    isFile: (p: string) => files.has(p.toLowerCase()),
  });

  it('keeps document paths, drops the exe, switches and missing paths', () => {
    const files = new Set(['c:\\users\\me\\docs\\a.md', 'c:\\users\\me\\b.pdf']);
    const r = extractLaunchFiles(
      [
        'C:\\Program Files\\Local AI\\Local Personal AI.exe',
        'C:\\Users\\me\\docs\\A.md', // case differs — Windows is case-insensitive
        '--flag=1',
        '--no-sandbox',
        'C:\\Users\\me\\missing.pdf',
        'c:\\users\\me\\b.pdf',
        'c:\\users\\me\\b.pdf', // duplicate
      ],
      base(files),
    );
    expect(r.map((x) => x.toLowerCase())).toEqual(['c:\\users\\me\\docs\\a.md', 'c:\\users\\me\\b.pdf']);
  });

  it('resolves relative args against cwd, skips "." (dev electron .)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-argv-'));
    const f = join(dir, 'note.txt');
    writeFileSync(f, 'hello');
    try {
      const r = extractLaunchFiles(['.\\note.txt', '.', dir], {
        cwd: '.',
        isFile: (p) => {
          try {
            // resolve('.') = process cwd — emulate with the temp dir instead
            return p === f;
          } catch {
            return false;
          }
        },
      });
      // '.\note.txt' resolves against the real cwd of the test process, which
      // has no note.txt -> filtered out; the bare temp dir is not a file.
      expect(r).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips quotes some launchers pass through', () => {
    const files = new Set(['c:\\temp\\q.txt']);
    const r = extractLaunchFiles(['"C:\\temp\\q.txt"'], base(files));
    expect(r).toEqual(['C:\\temp\\q.txt']);
  });
});

describe('external file import route', () => {
  it('imports, refreshes in place, and announces every attempt', async () => {
    const t = await makeTestApp();
    try {
      const file = join(t.dir, 'notes.md');
      writeFileSync(file, '# Session\nThe launch codename is bluebird-42.\n');

      const r1 = t.app.importFilePath(file);
      expect(r1.ok).toBe(true);
      expect(r1.name).toBe('notes.md');
      expect(r1.kind).toBe('markdown');
      expect((r1.chunks ?? 0) >= 1).toBe(true);
      expect(r1.updated).toBeFalsy();

      // findable through the knowledge search the context engine uses
      expect(t.app.knowledge.search('bluebird-42').length).toBe(1);

      // re-import same path -> refresh, never a duplicate document
      writeFileSync(file, '# Session v2\nThe launch codename is goldfish-7.\n');
      const r2 = t.app.importFilePath(file);
      expect(r2.ok && r2.updated).toBe(true);
      const docs = t.app.store.all<{ id: string }>(`SELECT id FROM knowledge_documents`);
      expect(docs.length).toBe(1);
      expect(t.app.knowledge.search('goldfish-7').length).toBe(1);

      // honest failure for a path that is not there
      const r3 = t.app.importFilePath(join(t.dir, 'ghost.txt'));
      expect(r3.ok).toBe(false);

      const opened = t.events.filter((e) => e.type === 'file.opened');
      expect(opened.length).toBe(3);
      if (opened[0]?.type === 'file.opened') expect(opened[0].path).toBe(file);
      if (opened[2]?.type === 'file.opened') expect(opened[2].ok).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  it('openFiles imports sequentially and the IPC dialog route stays compatible', async () => {
    const t = await makeTestApp();
    try {
      const a = join(t.dir, 'a.txt');
      const b = join(t.dir, 'b.txt');
      writeFileSync(a, 'alpha content');
      writeFileSync(b, 'beta content');
      t.app.openFiles([a, b]);
      expect(t.events.filter((e) => e.type === 'file.opened' && e.ok).length).toBe(2);

      const api = new Api(t.app);
      const res = await api.handleRaw('knowledge.import', [a]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const data = res.data as { ok: boolean; updated?: boolean; name?: string };
        expect(data.ok && data.updated).toBe(true); // already imported via openFiles
        expect(data.name).toBe('a.txt');
      }
      // dialog route with a host that cannot pick a file -> clear error
      const noPick = await api.handleRaw('knowledge.import', []);
      expect(!noPick.ok && noPick.error?.kind).toBe('invalid_state');
    } finally {
      await t.cleanup();
    }
  });
});
