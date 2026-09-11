/**
 * SQLite persistence — spec §33. better-sqlite3, WAL mode, forward-only
 * migrations tracked in PRAGMA user_version. Large binaries never go in
 * here (checkpoints/screenshots live on the filesystem).
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type SqlDatabase = Database.Database;

const nodeRequire = createRequire(import.meta.url);

/**
 * better-sqlite3 ships exactly ONE binary per ABI — and Node (vitest) plus
 * Electron (the app) have different ones. A mismatch is the classic fresh
 * Windows-checkout crash: `npm install` builds for Node, `electron .` then
 * dies with NODE_MODULE_VERSION. So the app keeps node_modules on the Node
 * ABI (tests never break) and Electron additionally probes `native/electron/`
 * for a fetched prebuilt binding (see scripts/prepare-native.mjs). The first
 * candidate that actually loads wins; `undefined` falls back to
 * better-sqlite3's own resolution — correct for packaged builds, where
 * electron-builder's npmRebuild already produced an Electron-ABI binary.
 */
export function resolveSqliteBinding(candidates: readonly (string | undefined)[]): unknown {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const mod = nodeRequire(c) as unknown;
      if (mod && typeof mod === 'object') return mod;
    } catch {
      /* wrong ABI or missing file — that is the signal to try the next candidate */
    }
  }
  return undefined;
}

const MIGRATIONS: string[] = [
  // v1 — foundation tables
  `
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
    base_url TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_health_json TEXT, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL,
    json TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_assignments (
    role TEXT PRIMARY KEY, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'CHAT',
    project_id TEXT, summary TEXT, topics_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, json TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
    user_request TEXT NOT NULL, task_class TEXT NOT NULL, conversation_id TEXT, project_id TEXT,
    summary TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id);

  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'stored',
    content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'global', project_id TEXT,
    json TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, confidence REAL NOT NULL DEFAULT 0.5,
    version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
    json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL,
    last_indexed_at TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
    lang TEXT, role TEXT, symbols_json TEXT, text_preview TEXT, indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_files ON project_files(project_id, rel);

  CREATE TABLE IF NOT EXISTS file_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, kind TEXT,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, tool TEXT NOT NULL, ok INTEGER NOT NULL,
    input_json TEXT, result_json TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tool_runs_task ON tool_runs(task_id);

  CREATE TABLE IF NOT EXISTS permission_grants (
    permission TEXT PRIMARY KEY, decision TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT, label TEXT NOT NULL, dir TEXT NOT NULL,
    manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS learning_events (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1, confidence REAL NOT NULL DEFAULT 0.3,
    promoted_skill_id TEXT, json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY, source_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    size INTEGER NOT NULL, meta_json TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks ON knowledge_chunks(doc_id);

  CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, component TEXT NOT NULL, state TEXT NOT NULL, message TEXT
  );
  `,
  // v2 — message full-text search (spec §34 "conversation history searchable")
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='rowid'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  `,
];

export class SqlStore {
  readonly db: SqlDatabase;

  constructor(
    public readonly path: string,
    /** pre-resolved better-sqlite3 addon object (see resolveSqliteBinding); omit for default resolution */
    binding?: unknown,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.db = new Database(path, binding ? { nativeBinding: binding as never } : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NODE_MODULE_VERSION/.test(msg)) {
        throw new Error(
          `${msg}\n\n` +
            'The installed better-sqlite3 binary was built for a different runtime.\n' +
            'Running in Electron?  -> npm run native:fetch   (fetches the matching prebuilt into native/electron, cached)\n' +
            'Running plain tests?  -> npm rebuild better-sqlite3',
        );
      }
      throw err;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.pragma('user_version', { simple: true }) as number;
    let version = typeof row === 'number' ? row : 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i] as string);
        this.db.pragma(`user_version = ${i + 1}`);
      })();
      version = i + 1;
    }
  }

  get(userVersion = false): unknown {
    if (userVersion) return this.db.pragma('user_version', { simple: true });
    return null;
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  get1<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
