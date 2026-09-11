import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../src/main/core/config.js';
import { EventBus } from '../src/main/core/eventBus.js';
import { redact } from '../src/main/core/logger.js';
import { isInside, resolveScopedPath } from '../src/main/security/fsSafe.js';
import { SqlStore } from '../src/main/storage/db.js';
import { defaultConfig } from '../src/shared/types/config.js';
import { validateJson } from '../src/shared/util/jsonSchema.js';
import { chunkText, estimateTokens, lexicalRelevance } from '../src/shared/util/text.js';

describe('config service', () => {
  it('roundtrips through atomic file writes and merges defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-cfg-'));
    try {
      const c = new ConfigService(dir);
      c.patch({ tools: { permissionMode: 'SAFE', allowedRoots: ['/tmp/x'] } });
      c.flush();
      expect(existsSync(join(dir, 'config.json'))).toBe(true);
      const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(raw.tools.permissionMode).toBe('SAFE');
      const c2 = new ConfigService(dir);
      expect(c2.get().tools.permissionMode).toBe('SAFE');
      expect(c2.get().ai.contextTokenBudget).toBe(defaultConfig().ai.contextTokenBudget); // default preserved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a corrupt config file (uses defaults, keeps backup)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-cfg2-'));
    try {
      writeFileSync(join(dir, 'config.json'), '{not json!!');
      const c = new ConfigService(dir);
      expect(c.get().version).toBe(1);
      expect(existsSync(join(dir, 'config.json'))).toBe(false); // moved aside
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('redaction (§35)', () => {
  it('redacts api keys, bearer tokens and passwords', () => {
    const out = redact('connecting with api_key=sk-abcdef123456 and Authorization: Bearer xyzabc098765 pw_secret= hunter2');
    expect(out).not.toContain('sk-abcdef123456');
    expect(out).not.toContain('xyzabc098765');
    expect(out).toContain('REDACTED');
  });
});

describe('event bus', () => {
  it('isolates listener failures and supports wildcard', () => {
    type Ev = { type: 'a'; n: number } | { type: 'b' };
    const bus = new EventBus<Ev>();
    const seen: number[] = [];
    bus.on('a', () => {
      throw new Error('bad listener');
    });
    bus.on('a', (e) => seen.push(e.n));
    let wild = 0;
    bus.onAny(() => wild++);
    expect(() => bus.emit({ type: 'a', n: 5 })).not.toThrow();
    expect(seen).toEqual([5]);
    expect(wild).toBe(1);
  });
});

describe('schema validation (RULE 6)', () => {
  const schema = {
    type: 'object',
    required: ['path', 'ops'],
    properties: {
      path: { type: 'string', minLength: 1 },
      ops: { type: 'array', items: { type: 'object', required: ['find'], properties: { find: { type: 'string' } } } },
      n: { type: 'integer', minimum: 1, maximum: 3 },
    },
  };
  it('accepts valid input, rejects the rest', () => {
    expect(validateJson(schema, { path: 'a.txt', ops: [{ find: 'x' }] }).ok).toBe(true);
    expect(validateJson(schema, { path: '', ops: [{ find: 'x' }] }).ok).toBe(false);
    expect(validateJson(schema, { path: 'a' }).errors.join()).toContain('ops');
    expect(validateJson(schema, { path: 'a', ops: [{ nope: 1 }] }).errors.join()).toContain('find');
    expect(validateJson(schema, { path: 'a', ops: [], n: 9 }).errors.join()).toContain('maximum');
  });
});

describe('text utils', () => {
  it('chunks line-aware with refs and estimates tokens', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]?.endLine ?? 0); // overlap allowed
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
  });
  it('lexical relevance prefers exact match', () => {
    const q = 'build crash';
    expect(lexicalRelevance(q, 'the build crashed again')).toBeGreaterThan(lexicalRelevance(q, 'totally unrelated recipe'));
  });
});

describe('filesystem scoping (§11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpai-fs-'));
  try {
    writeFileSync(join(dir, 'ok.txt'), 'hi');
    writeFileSync(join(dir, '..', 'lpai-escape-check.txt'), 'nope');
    it('allows inside, rejects escapes', () => {
      expect(isInside(dir, join(dir, 'ok.txt'))).toBe(true);
      const r = resolveScopedPath('../escape.txt', [dir]);
      expect(r.ok).toBe(false);
      const empty = resolveScopedPath('x.txt', []);
      expect(empty.ok).toBe(false);
      const nested = resolveScopedPath('nested/deep.txt', [dir]);
      expect(nested.ok).toBe(true);
    });
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 0);
  }
});

describe('sqlite schema (§33)', () => {
  it('creates all foundation tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpai-db-'));
    try {
      const store = new SqlStore(join(dir, 'lpai.db'));
      const tables = new Set(store.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name));
      for (const t of [
        'providers',
        'models',
        'conversations',
        'messages',
        'tasks',
        'task_events',
        'memory_entries',
        'skills',
        'projects',
        'project_files',
        'file_index',
        'tool_runs',
        'permission_grants',
        'checkpoints',
        'learning_events',
        'diagnostics',
        'knowledge_documents',
      ]) {
        expect(tables.has(t), `missing table ${t}`).toBe(true);
      }
      // FTS availability (§34)
      store.run(`INSERT INTO conversations (id,title,mode,created_at,updated_at) VALUES ('c','t','CHAT','2026-01-01','2026-01-01')`);
      store.run(
        `INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ('m1','c','user','the database migration crashed','2026-01-01')`,
      );
      const hits = store.all(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'migration'`);
      expect(hits.length).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
