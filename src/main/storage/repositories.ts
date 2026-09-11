/**
 * Typed repositories over SqlStore. Simple JSON-in-column pattern:
 * queryable columns + a `json` blob of the full record. Keeps Phase 1-7
 * fast to build; split into normalized columns later if queries demand it.
 */
import { nowIso } from '../../shared/types/common.js';
import type { ConversationSummary } from '../../shared/types/ipc.js';
import type { MemoryEntry, MemoryStatus } from '../../shared/types/memory.js';
import type { ChatMessage } from '../../shared/types/models.js';
import type { Skill } from '../../shared/types/skills.js';
import type { TaskEvent, TaskRecord, TaskStatus } from '../../shared/types/task.js';
import type { ToolResult, ToolRunRecord } from '../../shared/types/tools.js';
import type { SqlStore } from './db.js';

export class TaskRepo {
  constructor(private s: SqlStore) {}

  upsert(t: TaskRecord): void {
    this.s.run(
      `INSERT INTO tasks (id,title,status,priority,user_request,task_class,conversation_id,project_id,summary,json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, priority=excluded.priority, summary=excluded.summary, json=excluded.json, updated_at=excluded.updated_at`,
      t.id,
      t.title,
      t.status,
      t.priority,
      t.userRequest,
      t.taskClass,
      t.conversationId ?? null,
      t.projectId ?? null,
      t.summary ?? null,
      JSON.stringify(t),
      t.createdAt,
      t.updatedAt,
    );
  }

  get(id: string): TaskRecord | null {
    const row = this.s.get1<{ json: string }>(`SELECT json FROM tasks WHERE id = ?`, id);
    return row ? (JSON.parse(row.json) as TaskRecord) : null;
  }

  list(statuses?: TaskStatus[]): TaskRecord[] {
    const where = statuses && statuses.length > 0 ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.s
      .all<{ json: string }>(`SELECT json FROM tasks ${where} ORDER BY updated_at DESC LIMIT 200`, ...(statuses ?? []))
      .map((r) => JSON.parse(r.json) as TaskRecord);
  }

  appendEvent(ev: TaskEvent): void {
    this.s.run(
      `INSERT INTO task_events (task_id, at, type, json) VALUES (?,?,?,?)`,
      ev.taskId,
      ev.at,
      ev.type,
      JSON.stringify(ev.payload ?? null),
    );
  }

  events(taskId: string): TaskEvent[] {
    return this.s
      .all<{ at: string; type: string; json: string | null }>(
        `SELECT at, type, json FROM task_events WHERE task_id = ? ORDER BY id ASC`,
        taskId,
      )
      .map((r) => ({ taskId, at: r.at, type: r.type, payload: r.json ? JSON.parse(r.json) : undefined }));
  }
}

export class ConversationRepo {
  constructor(private s: SqlStore) {}

  create(id: string, title: string, mode: string, projectId?: string): void {
    const at = nowIso();
    this.s.run(
      `INSERT INTO conversations (id,title,mode,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      id,
      title,
      mode,
      projectId ?? null,
      at,
      at,
    );
  }

  touch(id: string): void {
    this.s.run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, nowIso(), id);
  }

  setSummary(id: string, summary: string): void {
    this.s.run(`UPDATE conversations SET summary = ? WHERE id = ?`, summary, id);
  }

  list(): ConversationSummary[] {
    return this.s
      .all<{
        id: string;
        title: string;
        mode: string;
        project_id: string | null;
        summary: string | null;
        created_at: string;
        updated_at: string;
        count: number;
      }>(
        `SELECT c.id, c.title, c.mode, c.project_id, c.summary, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS count
         FROM conversations c ORDER BY c.updated_at DESC LIMIT 100`,
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        mode: r.mode as ConversationSummary['mode'],
        projectId: r.project_id ?? undefined,
        summary: r.summary ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.count,
      }));
  }

  delete(id: string): boolean {
    this.s.run(`DELETE FROM messages WHERE conversation_id = ?`, id);
    return this.s.run(`DELETE FROM conversations WHERE id = ?`, id).changes > 0;
  }

  search(query: string): { conversationId: string; title: string; snippet: string }[] {
    const q = query.replace(/["]/g, ' ').trim();
    if (!q) return [];
    try {
      return this.s
        .all<{ cid: string; title: string; snippet: string }>(
          `SELECT m.conversation_id AS cid, c.title AS title,
                  substr(m.content, max(1, instr(lower(m.content), lower(?)) - 30), 160) AS snippet
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? ORDER BY rank LIMIT 30`,
          q,
          `${q
            .split(/\s+/)
            .map((w) => `"${w}"`)
            .join(' AND ')}*`,
        )
        .map((r) => ({ conversationId: r.cid, title: r.title, snippet: r.snippet }));
    } catch {
      // FTS syntax failure -> LIKE fallback
      return this.s
        .all<{ cid: string; title: string; snippet: string }>(
          `SELECT m.conversation_id AS cid, c.title AS title, substr(m.content,1,160) AS snippet
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT 30`,
          `%${q}%`,
        )
        .map((r) => ({ conversationId: r.cid, title: r.title, snippet: r.snippet }));
    }
  }
}

export class MessageRepo {
  constructor(private s: SqlStore) {}

  add(conversationId: string, msg: ChatMessage): void {
    this.s.run(
      `INSERT INTO messages (id, conversation_id, role, content, json, created_at) VALUES (?,?,?,?,?,?)`,
      msg.id,
      conversationId,
      msg.role,
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      JSON.stringify(msg),
      msg.createdAt ?? nowIso(),
    );
  }

  list(conversationId: string, limit = 400): ChatMessage[] {
    return this.s
      .all<{ json: string | null; role: string; content: string; created_at: string; id: string }>(
        `SELECT id, role, content, json, created_at FROM messages WHERE conversation_id = ? ORDER BY rowid ASC LIMIT ?`,
        conversationId,
        limit,
      )
      .map((r) =>
        r.json
          ? ({ ...(JSON.parse(r.json) as ChatMessage), createdAt: r.created_at } as ChatMessage)
          : ({ id: r.id, role: r.role as ChatMessage['role'], content: r.content, createdAt: r.created_at } as ChatMessage),
      );
  }
}

export class MemoryRepo {
  constructor(private s: SqlStore) {}

  upsert(e: MemoryEntry): void {
    this.s.run(
      `INSERT INTO memory_entries (id,type,status,content,importance,confidence,source,scope_kind,project_id,json,created_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, last_used_at=excluded.last_used_at, json=excluded.json, importance=excluded.importance, confidence=excluded.confidence`,
      e.id,
      e.type,
      e.status,
      e.content,
      e.importance,
      e.confidence,
      e.source,
      e.scope.kind,
      e.scope.projectId ?? null,
      JSON.stringify(e),
      e.createdAt,
      e.lastUsedAt ?? null,
    );
  }

  get(id: string): MemoryEntry | null {
    const r = this.s.get1<{ json: string }>(`SELECT json FROM memory_entries WHERE id=?`, id);
    return r ? (JSON.parse(r.json) as MemoryEntry) : null;
  }

  list(status?: MemoryStatus): MemoryEntry[] {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    return this.s
      .all<{ json: string }>(`SELECT json FROM memory_entries ${where} ORDER BY created_at DESC LIMIT 500`, ...params)
      .map((r) => JSON.parse(r.json) as MemoryEntry);
  }

  delete(id: string): boolean {
    return this.s.run(`DELETE FROM memory_entries WHERE id=?`, id).changes > 0;
  }

  markObsolete(ids: string[], supersededBy?: string): void {
    for (const id of ids) {
      const e = this.get(id);
      if (!e) continue;
      e.status = 'obsolete';
      this.upsert(e);
      void supersededBy;
    }
  }
}

export class SkillRepo {
  constructor(private s: SqlStore) {}

  upsert(sk: Skill): void {
    this.s.run(
      `INSERT INTO skills (id,name,description,enabled,confidence,version,source,json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, confidence=excluded.confidence, version=excluded.version, json=excluded.json, updated_at=excluded.updated_at`,
      sk.id,
      sk.name,
      sk.description,
      sk.enabled ? 1 : 0,
      sk.confidence,
      sk.version,
      sk.source,
      JSON.stringify(sk),
      sk.createdAt,
      sk.updatedAt,
    );
  }

  list(): Skill[] {
    return this.s.all<{ json: string }>(`SELECT json FROM skills ORDER BY updated_at DESC`).map((r) => JSON.parse(r.json) as Skill);
  }

  get(id: string): Skill | null {
    const r = this.s.get1<{ json: string }>(`SELECT json FROM skills WHERE id=?`, id);
    return r ? (JSON.parse(r.json) as Skill) : null;
  }

  delete(id: string): boolean {
    return this.s.run(`DELETE FROM skills WHERE id=?`, id).changes > 0;
  }
}

export class ProjectRepo {
  constructor(private s: SqlStore) {}

  upsert(p: { id: string; path: string; name: string; kind: string; json: string; createdAt: string; lastIndexedAt?: string }): void {
    this.s.run(
      `INSERT INTO projects (id,path,name,kind,last_indexed_at,json,created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET name=excluded.name, kind=excluded.kind, last_indexed_at=excluded.last_indexed_at, json=excluded.json`,
      p.id,
      p.path,
      p.name,
      p.kind,
      p.lastIndexedAt ?? null,
      p.json,
      p.createdAt,
    );
  }

  list(): { json: string }[] {
    return this.s.all<{ json: string }>(`SELECT json FROM projects ORDER BY created_at DESC`);
  }

  remove(id: string): void {
    this.s.run(`DELETE FROM project_files WHERE project_id=?`, id);
    this.s.run(`DELETE FROM projects WHERE id=?`, id);
  }

  upsertFiles(
    projectId: string,
    files: { path: string; rel: string; size: number; mtimeMs: number; lang: string; role: string; symbolsJson: string; preview: string }[],
  ): void {
    this.s.tx(() => {
      for (const f of files) {
        this.s.run(
          `INSERT INTO project_files (project_id,path,rel,size,mtime_ms,lang,role,symbols_json,text_preview,indexed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, lang=excluded.lang, role=excluded.role, symbols_json=excluded.symbols_json, text_preview=excluded.text_preview, indexed_at=excluded.indexed_at`,
          projectId,
          f.path,
          f.rel,
          f.size,
          f.mtimeMs,
          f.lang,
          f.role,
          f.symbolsJson,
          f.preview,
          nowIso(),
        );
      }
    });
  }

  removeFilesNotIn(projectId: string, keepPaths: string[]): void {
    if (keepPaths.length === 0) {
      this.s.run(`DELETE FROM project_files WHERE project_id=?`, projectId);
      return;
    }
    const marks = keepPaths.map(() => '?').join(',');
    this.s.run(`DELETE FROM project_files WHERE project_id=? AND path NOT IN (${marks})`, projectId, ...keepPaths);
  }

  files(
    projectId: string,
    limit = 5000,
  ): {
    path: string;
    rel: string;
    size: number;
    mtime_ms: number;
    lang: string | null;
    role: string | null;
    symbols_json: string | null;
    text_preview: string | null;
  }[] {
    return this.s.all(
      `SELECT path, rel, size, mtime_ms, lang, role, symbols_json, text_preview FROM project_files WHERE project_id=? LIMIT ?`,
      projectId,
      limit,
    );
  }
}

export class FileIndexRepo {
  constructor(private s: SqlStore) {}

  /** Batched write — one transaction instead of one implicit fsync per row (§55). */
  upsertMany(entries: { root: string; path: string; name: string; size: number; mtimeMs: number; kind: string }[]): void {
    if (entries.length === 0) return;
    const at = nowIso();
    this.s.tx(() => {
      for (const e of entries) this.upsert(e, at);
    });
  }

  upsert(entry: { root: string; path: string; name: string; size: number; mtimeMs: number; kind: string }, indexedAt = nowIso()): void {
    this.s.run(
      `INSERT INTO file_index (root,path,name,size,mtime_ms,kind,indexed_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
      entry.root,
      entry.path,
      entry.name,
      entry.size,
      entry.mtimeMs,
      entry.kind,
      indexedAt,
    );
  }

  search(nameQuery: string, limit = 40): { path: string; name: string; size: number; mtime_ms: number; kind: string }[] {
    return this.s.all(
      `SELECT path,name,size,mtime_ms,kind FROM file_index WHERE name LIKE ? ORDER BY mtime_ms DESC LIMIT ?`,
      `%${nameQuery}%`,
      limit,
    );
  }

  stats(): { total: number; roots: string[] } {
    const total = this.s.get1<{ c: number }>(`SELECT COUNT(*) AS c FROM file_index`)?.c ?? 0;
    const roots = this.s.all<{ root: string }>(`SELECT DISTINCT root FROM file_index`).map((r) => r.root);
    return { total, roots };
  }

  removeRoot(root: string): void {
    this.s.run(`DELETE FROM file_index WHERE root=?`, root);
  }
}

export class ToolRunRepo {
  constructor(private s: SqlStore) {}

  record(r: ToolRunRecord): void {
    this.s.run(
      `INSERT INTO tool_runs (task_id,tool,ok,input_json,result_json,started_at,ended_at,duration_ms) VALUES (?,?,?,?,?,?,?,?)`,
      r.taskId ?? null,
      r.tool,
      r.ok ? 1 : 0,
      JSON.stringify(r.input ?? null),
      JSON.stringify(r.result ?? null),
      r.startedAt,
      r.endedAt ?? null,
      r.durationMs ?? null,
    );
  }

  result<T = ToolResult>(id: number): T | null {
    const row = this.s.get1<{ result_json: string | null }>(`SELECT result_json FROM tool_runs WHERE id=?`, id);
    return row?.result_json ? (JSON.parse(row.result_json) as T) : null;
  }

  recent(limit = 50): { tool: string; ok: number; task_id: string | null; started_at: string }[] {
    return this.s.all(`SELECT tool, ok, task_id, started_at FROM tool_runs ORDER BY id DESC LIMIT ?`, limit);
  }
}

export class PermissionGrantRepo {
  constructor(private s: SqlStore) {}

  set(permission: string, decision: 'allow' | 'deny'): void {
    this.s.run(
      `INSERT INTO permission_grants (permission, decision, updated_at) VALUES (?,?,?)
       ON CONFLICT(permission) DO UPDATE SET decision=excluded.decision, updated_at=excluded.updated_at`,
      permission,
      decision,
      nowIso(),
    );
  }

  get(permission: string): 'allow' | 'deny' | null {
    const r = this.s.get1<{ decision: 'allow' | 'deny' }>(`SELECT decision FROM permission_grants WHERE permission=?`, permission);
    return r?.decision ?? null;
  }

  clear(permission: string): void {
    this.s.run(`DELETE FROM permission_grants WHERE permission=?`, permission);
  }

  all(): { permission: string; decision: 'allow' | 'deny'; updated_at: string }[] {
    return this.s.all(`SELECT permission, decision, updated_at FROM permission_grants`);
  }
}

export class CheckpointRepo {
  constructor(private s: SqlStore) {}

  add(c: { id: string; taskId?: string; label: string; dir: string; manifest: string; createdAt: string }): void {
    this.s.run(
      `INSERT INTO checkpoints (id, task_id, label, dir, manifest_json, created_at) VALUES (?,?,?,?,?,?)`,
      c.id,
      c.taskId ?? null,
      c.label,
      c.dir,
      c.manifest,
      c.createdAt,
    );
  }

  list(): { id: string; task_id: string | null; label: string; dir: string; manifest_json: string; created_at: string }[] {
    return this.s.all(`SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 50`);
  }

  get(
    id: string,
  ): { id: string; task_id: string | null; label: string; dir: string; manifest_json: string; created_at: string } | undefined {
    return this.s.get1(`SELECT * FROM checkpoints WHERE id=?`, id);
  }

  prune(keep = 30): void {
    this.s.run(`DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY created_at DESC LIMIT ?)`, keep);
  }
}

export class LearningEventRepo {
  constructor(private s: SqlStore) {}

  upsert(e: {
    id: string;
    at: string;
    kind: string;
    key: string;
    occurrences: number;
    confidence: number;
    promotedSkillId?: string;
    json: string;
  }): void {
    this.s.run(
      `INSERT INTO learning_events (id,at,kind,key,occurrences,confidence,promoted_skill_id,json) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET occurrences=excluded.occurrences, confidence=excluded.confidence, promoted_skill_id=excluded.promoted_skill_id, json=excluded.json`,
      e.id,
      e.at,
      e.kind,
      e.key,
      e.occurrences,
      e.confidence,
      e.promotedSkillId ?? null,
      e.json,
    );
  }

  listAll(): { json: string }[] {
    return this.s.all<{ json: string }>(`SELECT json FROM learning_events ORDER BY at DESC LIMIT 200`);
  }
}

export class RoleAssignmentRepo {
  constructor(private s: SqlStore) {}

  set(role: string, modelId: string, providerId: string): void {
    this.s.run(
      `INSERT INTO role_assignments (role, model_id, provider_id, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(role) DO UPDATE SET model_id=excluded.model_id, provider_id=excluded.provider_id, updated_at=excluded.updated_at`,
      role,
      modelId,
      providerId,
      nowIso(),
    );
  }

  remove(role: string): void {
    this.s.run(`DELETE FROM role_assignments WHERE role=?`, role);
  }

  list(): { role: string; model_id: string; provider_id: string; updated_at: string }[] {
    return this.s.all(`SELECT * FROM role_assignments`);
  }
}

export class KnowledgeRepo {
  constructor(private s: SqlStore) {}

  addDoc(
    doc: { id: string; sourcePath: string; name: string; kind: string; size: number; metaJson: string; createdAt: string },
    chunks: string[],
  ): void {
    this.s.tx(() => {
      this.s.run(
        `INSERT INTO knowledge_documents (id,source_path,name,kind,size,meta_json,created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET size=excluded.size, meta_json=excluded.meta_json`,
        doc.id,
        doc.sourcePath,
        doc.name,
        doc.kind,
        doc.size,
        doc.metaJson,
        doc.createdAt,
      );
      this.s.run(`DELETE FROM knowledge_chunks WHERE doc_id=?`, doc.id);
      chunks.forEach((c, i) => {
        this.s.run(`INSERT INTO knowledge_chunks (doc_id, idx, text) VALUES (?,?,?)`, doc.id, i, c);
      });
    });
  }

  search(query: string, limit = 10): { doc_id: string; name: string; kind: string; idx: number; text: string }[] {
    return this.s.all(
      `SELECT k.doc_id, d.name, d.kind, k.idx, k.text FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.doc_id
       WHERE k.text LIKE ? LIMIT ?`,
      `%${query}%`,
      limit,
    );
  }
}
