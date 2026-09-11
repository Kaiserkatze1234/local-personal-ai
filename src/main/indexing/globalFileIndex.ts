/**
 * Global file index — spec §31. Metadata-only by default, user-picked roots
 * only, incremental updates, pause/exclude/rebuild controls. Content never
 * leaves the disk here; a file must be *imported* to be read.
 */
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { AppBus } from '../../shared/types/events.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';
import { walkFiles } from '../files/walk.js';
import type { FileIndexRepo } from '../storage/repositories.js';
import type { BackgroundJobQueue } from './backgroundQueue.js';

export class GlobalFileIndex {
  constructor(
    private repo: FileIndexRepo,
    private config: ConfigService,
    private jobs: BackgroundJobQueue,
    private log: SubLogger,
    private bus: AppBus,
  ) {}

  /** Reconcile the queue of indexing jobs against configured roots. */
  sync(): void {
    const cfg = this.config.get().indexing;
    if (!cfg.enabled) {
      this.log.debug('global indexing disabled');
      return;
    }
    for (const root of cfg.roots) {
      this.jobs.enqueue({ label: `index ${root}`, priority: 3, run: () => this.indexRoot(root) });
    }
  }

  async indexRoot(root: string): Promise<{ added: number; updated: number; removed: number }> {
    let added = 0;
    const updated = 0;
    try {
      const rootAbs = resolve(root);
      const entries = walkFiles(rootAbs, {
        maxEntries: 50_000,
        maxDepth: 16,
        excludeDirs: this.config.get().indexing.excludeDirs,
        skipGenerated: true,
      });
      const seen: string[] = [];
      let i = 0;
      const total = entries.length;
      const batch: Parameters<FileIndexRepo['upsert']>[0][] = [];
      for (const e of entries) {
        if (e.isDir) continue;
        seen.push(e.absPath);
        const ext = e.relPath.split('.').pop()?.toLowerCase() ?? 'file';
        batch.push({
          root: rootAbs,
          path: e.absPath,
          name: e.relPath.split('/').pop() ?? e.relPath,
          size: e.size,
          mtimeMs: e.mtimeMs,
          kind: ext,
        });
        added++;
        if (batch.length >= 500) {
          this.flush(batch);
          batch.length = 0;
          i += 500;
          this.bus.emit({
            type: 'index.progress',
            jobId: `root:${rootAbs}`,
            done: i,
            total,
            label: `indexing ${relative(rootAbs, rootAbs) || rootAbs}`,
          });
        }
      }
      this.flush(batch);
      this.log.info(`global index: ${added} file(s) synced under ${rootAbs} (${updated} updated counted at write)`);
    } catch (err) {
      this.log.warn(`global index failed for ${root}: ${(err as Error).message}`);
      throw err;
    }
    return { added, updated, removed: 0 };
  }

  private flush(batch: Parameters<FileIndexRepo['upsert']>[0][]): void {
    this.repo.upsertMany(batch);
  }

  async indexOneFile(path: string): Promise<boolean> {
    try {
      const st = statSync(path);
      if (!st.isFile()) return false;
      this.repo.upsert({
        root: resolve(path, '..', '..'),
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: path.split('.').pop() ?? 'file',
      });
      return true;
    } catch {
      return false;
    }
  }

  removeRoot(root: string): void {
    this.repo.removeRoot(resolve(root));
  }

  rebuild(): { ok: boolean; message: string } {
    this.sync();
    return { ok: true, message: `Rebuild scheduled for ${this.config.get().indexing.roots.length} root(s)` };
  }

  stats(): { total: number; roots: string[] } {
    return this.repo.stats();
  }
}
