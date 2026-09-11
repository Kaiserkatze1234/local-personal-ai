/**
 * Checkpoint & rollback — spec §37. Content-addressed file snapshots kept
 * under <dataDir>/checkpoints/<id>. Git is recorded when available but not
 * required ("do not assume every directory is a Git repository").
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { newId, nowIso } from '../../shared/types/common.js';
import type { CheckpointInfo } from '../../shared/types/ipc.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import { atomicWrite } from '../security/fsSafe.js';
import type { CheckpointRepo } from '../storage/repositories.js';

const pExecFile = promisify(execFile);

export interface CheckpointManifest {
  id: string;
  label: string;
  taskId?: string;
  createdAt: string;
  files: { originalPath: string; relPath: string; size: number; sha256: string }[];
  git?: { isRepo: boolean; head?: string; branch?: string; dirty: boolean };
}

export class CheckpointService {
  constructor(
    private dataDir: string,
    private repo: CheckpointRepo,
    private log: SubLogger,
  ) {}

  get dir(): string {
    return join(this.dataDir, 'checkpoints');
  }

  private static sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  async createForFiles(label: string, files: string[], taskId?: string): Promise<CheckpointInfo | null> {
    const existing = files.filter((f) => existsSync(f));
    if (existing.length === 0) return null; // nothing to save
    const id = newId('ckpt');
    const dir = join(this.dir, id);
    mkdirSync(dir, { recursive: true });
    const manifest: CheckpointManifest = { id, label, taskId, createdAt: nowIso(), files: [] };
    // group by project root to preserve relative structure
    const roots = new Set(existing.map((f) => resolve(f).split(/[\\/]/).slice(0, 3).join('/')));
    void roots;
    for (const f of existing) {
      let content: Buffer;
      try {
        content = readFileSync(f);
      } catch (err) {
        this.log.warn(`checkpoint ${id}: cannot read ${f}: ${(err as Error).message}`);
        continue;
      }
      const safeRel = f
        .replace(/^[a-zA-Z]:[\\/]/, '')
        .replace(/^\/+/, '')
        .replaceAll('\\', '/');
      const dest = join(dir, 'files', safeRel);
      const hash = CheckpointService.sha256(content);
      atomicWrite(dest, content);
      manifest.files.push({ originalPath: f, relPath: safeRel, size: content.length, sha256: hash });
    }
    if (manifest.files.length === 0) return null;
    manifest.git = await this.gitInfo(manifest.files[0]?.originalPath ? join(manifest.files[0].originalPath, '..') : this.dataDir);
    atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    this.repo.add({ id, taskId, label, dir, manifest: JSON.stringify(manifest), createdAt: manifest.createdAt });
    this.repo.prune(30);
    this.log.info(`checkpoint ${id} created for ${manifest.files.length} file(s)`);
    return {
      id,
      label,
      taskId,
      createdAt: manifest.createdAt,
      fileCount: manifest.files.length,
      gitBranch: manifest.git?.branch,
      gitHead: manifest.git?.head,
    };
  }

  /** Best-effort git context for transparency (§37 "highly desirable"). */
  private async gitInfo(startDir: string): Promise<CheckpointManifest['git'] | undefined> {
    if (!startDir) return undefined;
    try {
      const { stdout } = await pExecFile('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: startDir,
        timeout: 5000,
        windowsHide: true,
      });
      if (stdout.trim() !== 'true') return { isRepo: false, dirty: false };
      const [head, branch, status] = await Promise.all([
        pExecFile('git', ['rev-parse', 'HEAD'], { cwd: startDir, timeout: 5000, windowsHide: true })
          .then((r) => r.stdout.trim())
          .catch(() => undefined),
        pExecFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: startDir, timeout: 5000, windowsHide: true })
          .then((r) => r.stdout.trim())
          .catch(() => undefined),
        pExecFile('git', ['status', '--porcelain'], { cwd: startDir, timeout: 5000, windowsHide: true })
          .then((r) => r.stdout.trim().length > 0)
          .catch(() => true),
      ]);
      return { isRepo: true, head, branch, dirty: status };
    } catch {
      return { isRepo: false, dirty: false };
    }
  }

  list(): CheckpointInfo[] {
    return this.repo.list().map((r) => {
      let count = 0;
      let gitBranch: string | undefined;
      let gitHead: string | undefined;
      try {
        const m = JSON.parse(r.manifest_json) as CheckpointManifest;
        count = m.files.length;
        gitBranch = m.git?.branch;
        gitHead = m.git?.head;
      } catch {
        /* keep zeros */
      }
      return { id: r.id, label: r.label, taskId: r.task_id ?? undefined, createdAt: r.created_at, fileCount: count, gitBranch, gitHead };
    });
  }

  /** Restore all files of a checkpoint; creates a safety snapshot of current state first. */
  async restore(id: string): Promise<{ ok: boolean; message: string }> {
    const row = this.repo.get(id);
    if (!row) return { ok: false, message: `Checkpoint ${id} not found` };
    const manifest = JSON.parse(row.manifest_json) as CheckpointManifest;
    // safety: snapshot current contents (unless absent) so restore is itself recoverable
    const currentlyPresent = manifest.files.filter((f) => existsSync(f.originalPath)).map((f) => f.originalPath);
    if (currentlyPresent.length > 0) {
      await this.createForFiles(`pre-restore snapshot of ${id}`, currentlyPresent, manifest.taskId);
    }
    let restored = 0;
    const mismatches: string[] = [];
    for (const f of manifest.files) {
      const snapPath = join(row.dir, 'files', f.relPath);
      if (!existsSync(snapPath)) {
        mismatches.push(`missing snapshot for ${f.relPath}`);
        continue;
      }
      const content = readFileSync(snapPath);
      if (CheckpointService.sha256(content) !== f.sha256) mismatches.push(`checksum mismatch for ${f.relPath}`);
      atomicWrite(f.originalPath, content);
      restored++;
    }
    this.log.info(`checkpoint ${id} restored ${restored}/${manifest.files.length} file(s)`);
    return {
      ok: restored > 0,
      message:
        restored === manifest.files.length
          ? `Restored ${restored} file(s) from checkpoint "${manifest.label}".`
          : `Restored ${restored}/${manifest.files.length} file(s)${mismatches.length > 0 ? `; issues: ${mismatches.join('; ')}` : ''}`,
    };
  }

  /** Verify current file states against a checkpoint (verification §38 support). */
  status(id: string): { changed: string[]; deleted: string[]; intact: string[] } | null {
    const row = this.repo.get(id);
    if (!row) return null;
    const manifest = JSON.parse(row.manifest_json) as CheckpointManifest;
    const out = { changed: [] as string[], deleted: [] as string[], intact: [] as string[] };
    for (const f of manifest.files) {
      if (!existsSync(f.originalPath)) {
        out.deleted.push(f.originalPath);
        continue;
      }
      const cur = CheckpointService.sha256(readFileSync(f.originalPath));
      (cur === f.sha256 ? out.intact : out.changed).push(f.originalPath);
    }
    return out;
  }
}

export function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export { relative };
export function checkpointDirFor(dataDir: string, id: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(id)) throw AppError.invalidState('bad checkpoint id');
  return join(dataDir, 'checkpoints', id);
}
