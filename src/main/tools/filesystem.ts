/**
 * Filesystem tools — spec §10/§12/§14. Scoped roots (§11/§75 "file access
 * is scoped"), atomic writes, size-guarded reads, patch-based edits.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import type { ToolResult } from '../../shared/types/tools.js';
import { truncateMiddle } from '../../shared/util/text.js';
import { walkFiles } from '../files/walk.js';
import { atomicWrite, resolveScopedPath } from '../security/fsSafe.js';
import type { ToolRegistry, ToolRunContext } from './registry.js';

const READ_CAP_BYTES = 512 * 1024;

function scopedPath(
  input: Record<string, unknown>,
  ctx: ToolRunContext,
  mode: 'read' | 'write',
): { ok: true; abs: string } | { ok: false; error: string } {
  const roots = mode === 'read' ? ctx.fsRoots().read : ctx.fsRoots().write;
  const raw = String(input.path ?? '');
  const r = resolveScopedPath(raw, roots, ctx.cwd());
  if (!r.ok || !r.path) return { ok: false, error: r.error ?? 'invalid path' };
  return { ok: true, abs: r.path };
}

function isBinary(abs: string): boolean {
  try {
    const fd = readFileSync(abs);
    const head = fd.subarray(0, 4096);
    for (const b of head) if (b === 0) return true;
    return false;
  } catch {
    return true;
  }
}

export function registerFilesystemTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'list_dir',
      description: 'List entries of a directory inside accessible roots. Returns names, sizes, and file/dir flags.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 3 } },
        required: ['path'],
      },
      permission: 'fs.read',
      mutating: false,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'read');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      try {
        const entries = walkFiles(s.abs, { maxEntries: 400, maxDepth: Number(input.depth ?? 1), skipGenerated: true });
        return {
          ok: true,
          summary: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} under ${relative(resolve('.'), s.abs) || '.'}`,
          data: entries.map((e) => ({ name: e.relPath, kind: e.isDir ? 'dir' : 'file', size: e.size })),
        };
      } catch (err) {
        return {
          ok: false,
          summary: `list_dir failed: ${(err as Error).message}`,
          error: { kind: 'filesystem', message: (err as Error).message },
        };
      }
    },
  );

  registry.register(
    {
      name: 'read_file',
      description: 'Read a text file (UTF-8). Large files are truncated to a head+tail window; use search for targeted lookups.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } },
        required: ['path'],
      },
      permission: 'fs.read',
      mutating: false,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'read');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      if (!existsSync(s.abs) || !statSync(s.abs).isFile())
        return { ok: false, summary: `Not a file: ${s.abs}`, error: { kind: 'filesystem', message: 'not found' } };
      const size = statSync(s.abs).size;
      if (size > READ_CAP_BYTES)
        return {
          ok: false,
          summary: `File too large for direct read (${size} bytes). Read it in line ranges (startLine/endLine) or use search_files.`,
          error: { kind: 'invalid_state', message: 'size cap' },
        };
      if (isBinary(s.abs))
        return {
          ok: false,
          summary: 'Binary file — not shown as text. Use project/vision tooling for supported types.',
          error: { kind: 'invalid_state', message: 'binary' },
        };
      let text = readFileSync(s.abs, 'utf8');
      const startLine = typeof input.startLine === 'number' ? Math.max(1, input.startLine) : undefined;
      const endLine = typeof input.endLine === 'number' ? (startLine ?? 1) : undefined;
      let truncated = false;
      if (startLine && endLine !== undefined && endLine >= startLine) {
        const lines = text.split('\n').slice(startLine - 1, endLine);
        text = lines.join('\n');
        truncated = true;
      }
      const capped = truncateMiddle(text, 24_000);
      return {
        ok: true,
        summary: `Read ${s.abs}${truncated || capped !== text ? ' (windowed)' : ''} (${size} bytes)`,
        data: { path: s.abs, text: capped },
      };
    },
  );

  registry.register(
    {
      name: 'search_files',
      description:
        'Exact-text search for a substring/regex across files under a directory (filename match included). Cheap strategy first.',
      inputSchema: {
        type: 'object',
        properties: { dir: { type: 'string' }, query: { type: 'string' }, regex: { type: 'boolean' }, maxResults: { type: 'integer' } },
        required: ['dir', 'query'],
      },
      permission: 'fs.read',
      mutating: false,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath({ path: String(input.dir ?? '') }, ctx, 'read');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      const query = String(input.query ?? '');
      if (!query) return { ok: false, summary: 'Empty query', error: { kind: 'user', message: 'query required' } };
      let re: RegExp | null = null;
      if (input.regex === true) {
        try {
          re = new RegExp(query, 'i');
        } catch {
          return { ok: false, summary: 'Invalid regex', error: { kind: 'user', message: 'bad regex' } };
        }
      }
      const max = Math.min(200, Number(input.maxResults ?? 40));
      const files = walkFiles(s.abs, { maxEntries: 5000, maxDepth: 12, skipGenerated: true }).filter((e) => !e.isDir);
      const hits: { file: string; line: number; text: string }[] = [];
      const lower = query.toLowerCase();
      for (const f of files) {
        if (hits.length >= max) break;
        if (!re && basename(f.absPath).toLowerCase().includes(lower)) {
          hits.push({ file: f.relPath, line: 0, text: '⟨filename match⟩' });
        }
        if (f.size > 256 * 1024) continue;
        let content: string;
        try {
          content = readFileSync(f.absPath, 'utf8');
        } catch {
          continue;
        }
        if (!re && !content.toLowerCase().includes(lower)) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if ((re ? re.test(line) : line.toLowerCase().includes(lower)) && hits.length < max) {
            hits.push({ file: f.relPath, line: i + 1, text: line.slice(0, 240) });
          }
        }
      }
      return { ok: true, summary: `${hits.length} match(es) for "${query}"${hits.length >= max ? ' (capped)' : ''}`, data: { hits } };
    },
  );

  registry.register(
    {
      name: 'write_file',
      description: 'Create or overwrite a text file inside a writable root. Atomic; a checkpoint is recommended for existing files.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, mkdir: { type: 'boolean' } },
        required: ['path', 'content'],
      },
      permission: 'fs.write',
      mutating: true,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'write');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      if (existsSync(s.abs) && input.mkdir === undefined && !statSync(s.abs).isFile())
        return { ok: false, summary: 'Target exists but is not a file', error: { kind: 'filesystem', message: 'not a file' } };
      atomicWrite(s.abs, String(input.content ?? ''));
      return {
        ok: true,
        summary: `Wrote ${s.abs} (${String(input.content ?? '').length} chars)`,
        data: { path: s.abs, bytes: Buffer.byteLength(String(input.content ?? '')) },
      };
    },
  );

  registry.register(
    {
      name: 'patch_file',
      description:
        'Precise find/replace edits on an existing file. Each op must match exactly once unless count>1. Fails atomically if any op misses — re-read and retry.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: { find: { type: 'string' }, replace: { type: 'string' }, count: { type: 'integer' } },
              required: ['find', 'replace'],
            },
          },
        },
        required: ['path', 'ops'],
      },
      permission: 'fs.write',
      mutating: true,
      phase: 6,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'write');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      if (!existsSync(s.abs))
        return { ok: false, summary: `patch_file: file does not exist: ${s.abs}`, error: { kind: 'filesystem', message: 'not found' } };
      let text = readFileSync(s.abs, 'utf8');
      const ops = (Array.isArray(input.ops) ? input.ops : []) as { find: string; replace: string; count?: number }[];
      const applied: string[] = [];
      for (const [i, op] of ops.entries()) {
        if (typeof op.find !== 'string' || op.find.length === 0)
          return { ok: false, summary: `op ${i}: empty find`, error: { kind: 'user', message: 'find must be non-empty' } };
        const occurrences = text.split(op.find).length - 1;
        const expected = op.count ?? 1;
        if (occurrences !== expected) {
          return {
            ok: false,
            summary: `patch_file aborted: op ${i} expected ${expected} match(es) of find-string, found ${occurrences}. No changes were written.`,
            error: { kind: 'tool', message: 'patch context mismatch', recovery: ['Re-read the file and use an exact, unique snippet'] },
          };
        }
        text = text.split(op.find).join(op.replace ?? '');
        applied.push(op.find.slice(0, 60));
      }
      atomicWrite(s.abs, text);
      return { ok: true, summary: `Patched ${s.abs}: ${ops.length} op(s) applied`, data: { path: s.abs, appliedFor: applied.length } };
    },
  );

  registry.register(
    {
      name: 'make_dir',
      description: 'Create a directory (parents included) inside a writable root.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      permission: 'fs.write',
      mutating: true,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'write');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      mkdirSync(s.abs, { recursive: true });
      return { ok: true, summary: `Created directory ${s.abs}` };
    },
  );

  registry.register(
    {
      name: 'move_path',
      description: 'Move/rename a file or directory within writable roots.',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      permission: 'fs.write',
      mutating: true,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const a = scopedPath({ path: String(input.from) }, ctx, 'write');
      const b = scopedPath({ path: String(input.to) }, ctx, 'write');
      if (!a.ok) return { ok: false, summary: a.error, error: { kind: 'filesystem', message: a.error } };
      if (!b.ok) return { ok: false, summary: b.error, error: { kind: 'filesystem', message: b.error } };
      if (!existsSync(a.abs))
        return { ok: false, summary: `Source missing: ${a.abs}`, error: { kind: 'filesystem', message: 'not found' } };
      mkdirSync(dirname(b.abs), { recursive: true });
      renameSync(a.abs, b.abs);
      return { ok: true, summary: `Moved ${basename(a.abs)} → ${b.abs}`, data: { from: a.abs, to: b.abs } };
    },
  );

  registry.register(
    {
      name: 'delete_path',
      description: 'Delete a file (recursive only when recursive=true). Always permission-gated; prefer making a checkpoint first.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
      permission: 'fs.delete',
      mutating: true,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const s = scopedPath(input, ctx, 'write');
      if (!s.ok) return { ok: false, summary: s.error, error: { kind: 'filesystem', message: s.error } };
      if (!existsSync(s.abs))
        return { ok: false, summary: `Nothing to delete: ${s.abs}`, error: { kind: 'filesystem', message: 'not found' } };
      const st = statSync(s.abs);
      if (st.isDirectory() && input.recursive !== true)
        return {
          ok: false,
          summary: 'Directory deletion requires recursive=true.',
          error: { kind: 'invalid_state', message: 'dir needs explicit recursive' },
        };
      rmSync(s.abs, { recursive: input.recursive === true, force: false });
      return { ok: true, summary: `Deleted ${s.abs}` };
    },
  );
}
