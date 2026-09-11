/**
 * Memory — spec §16 (categories/metadata), §17 (compression: more experience
 * without proportional context growth), §64 (relevance+recency+importance,
 * never "similar but irrelevant"), §61 (knowledge/skills stay separate).
 */
import { newId, nowIso } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { MemoryEntry, MemorySearchHit, MemoryStatus, MemoryType } from '../../shared/types/memory.js';
import { jaccard, lexicalRelevance, tokenize } from '../../shared/util/text.js';
import type { ConfigService } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { MemoryRepo } from '../storage/repositories.js';

export interface AddMemoryInput {
  content: string;
  type: MemoryType;
  importance?: number;
  confidence?: number;
  source?: MemoryEntry['source'];
  projectId?: string;
  relatedTaskIds?: string[];
  /** Skip the review step (explicit user command like "remember that ..."). */
  autoConfirm?: boolean;
}

export class MemoryService {
  constructor(
    private repo: MemoryRepo,
    private config: ConfigService,
    private bus: AppBus,
    private log: SubLogger,
  ) {}

  isEnabled(): boolean {
    return this.config.get().memory.enabled;
  }

  add(input: AddMemoryInput): MemoryEntry {
    if (!this.isEnabled()) throw AppError.invalidState('Memory is disabled in settings.');
    const cfg = this.config.get().memory;
    const nearDup = this.findNearDuplicate(input.content);
    if (nearDup) {
      // §17 remove redundancy at write time rather than letting it pile up.
      nearDup.importance = Math.min(1, nearDup.importance + 0.05);
      nearDup.lastUsedAt = nowIso();
      this.repo.upsert(nearDup);
      this.log.debug(`memory dedup: merged into ${nearDup.id}`);
      return nearDup;
    }
    const entry: MemoryEntry = {
      id: newId('mem'),
      type: input.type,
      status: cfg.requireReview && !input.autoConfirm ? 'candidate' : 'stored',
      content: input.content.trim(),
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.6,
      source: input.source ?? 'agent',
      scope: input.projectId ? { kind: 'project', projectId: input.projectId } : { kind: 'global' },
      relatedTaskIds: input.relatedTaskIds ?? [],
      supersedesIds: [],
      createdAt: nowIso(),
      usedCount: 0,
    };
    this.repo.upsert(entry);
    if (entry.status === 'candidate') this.bus.emit({ type: 'memory.candidate', entryId: entry.id, preview: entry.content.slice(0, 120) });
    return entry;
  }

  private findNearDuplicate(content: string): MemoryEntry | null {
    const cset = new Set(tokenize(content));
    if (cset.size < 3) return null;
    for (const e of this.repo.list('stored').concat(this.repo.list('candidate'))) {
      if (e.type !== 'preference' && e.type !== 'fact') continue;
      const eset = new Set(tokenize(e.content));
      if (jaccard(cset, eset) >= 0.85) return e;
    }
    return null;
  }

  confirm(id: string): boolean {
    const e = this.repo.get(id);
    if (e?.status !== 'candidate') return false;
    e.status = 'stored';
    this.repo.upsert(e);
    return true;
  }

  list(status?: MemoryStatus): MemoryEntry[] {
    return this.repo.list(status);
  }

  delete(id: string): boolean {
    return this.repo.delete(id);
  }

  /** §64: blend of lexical relevance, recency, importance, confidence, scope. */
  async search(query: string, opts: { projectId?: string; limit?: number; minScore?: number } = {}): Promise<MemorySearchHit[]> {
    if (!this.isEnabled()) return [];
    const limit = opts.limit ?? 6;
    const minScore = opts.minScore ?? 0.18;
    const scored: MemorySearchHit[] = [];
    const now = Date.now();
    for (const e of this.repo.list('stored')) {
      if (e.scope.kind === 'project' && e.scope.projectId && opts.projectId && e.scope.projectId !== opts.projectId) continue;
      if (e.scope.kind === 'project' && opts.projectId === undefined) continue; // project memory without active project: skip
      const lex = lexicalRelevance(query, e.content);
      const ageDays = (now - Date.parse(e.createdAt)) / 86_400_000;
      const recency = 1 / (1 + ageDays / 30);
      const scopeBoost = e.scope.kind === 'project' && e.scope.projectId === opts.projectId ? 0.15 : 0;
      const score = 0.5 * lex + 0.12 * recency + 0.22 * e.importance + 0.11 * e.confidence + scopeBoost;
      if (lex === 0 && score < 0.45) continue; // §64: do not inject irrelevant-but-stored noise
      scored.push({ entry: e, score: Math.min(1, score), matchedBy: lex > 0 ? 'lexical' : 'importance' });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.filter((s) => s.score >= minScore).slice(0, limit);
    for (const h of hits) {
      h.entry.lastUsedAt = nowIso();
      h.entry.usedCount += 1;
      this.repo.upsert(h.entry);
    }
    return hits;
  }

  /**
   * §17 maintenance: merge near-duplicates, expire obsolete + low-importance
   * episodes older than retention, cap stored size. Deliberately model-free
   * here (compression *can* use a model; the wiring lives in backgroundJobs).
   */
  compress(): { merged: number; removed: number } {
    let merged = 0;
    let removed = 0;
    const cfg = this.config.get().memory;
    if (!cfg.compressionEnabled) return { merged, removed };
    const all = this.repo.list('stored');
    const seen: { entry: MemoryEntry; set: Set<string> }[] = [];
    for (const e of all) {
      const set = new Set(tokenize(e.content));
      const dup = seen.find(
        (s) => s.entry.type === e.type && (s.entry.scope.projectId ?? '') === (e.scope.projectId ?? '') && jaccard(s.set, set) >= 0.82,
      );
      if (dup) {
        // keep the older entry, note supersession, delete the newer duplicate
        dup.entry.content = dup.entry.content.length >= e.content.length ? dup.entry.content : e.content;
        dup.entry.supersedesIds.push(e.id);
        dup.entry.importance = Math.min(1, Math.max(dup.entry.importance, e.importance) + 0.02);
        this.repo.upsert(dup.entry);
        this.repo.delete(e.id);
        merged++;
      } else {
        seen.push({ entry: e, set });
      }
    }
    if (cfg.retentionDays > 0) {
      const cutoff = Date.now() - cfg.retentionDays * 86_400_000;
      for (const e of this.repo.list('stored')) {
        if (e.type === 'episode' && e.importance < 0.35 && Date.parse(e.createdAt) < cutoff) {
          this.repo.delete(e.id);
          removed++;
        }
      }
    }
    if (merged + removed > 0) this.log.info(`memory maintenance: merged ${merged}, removed ${removed}`);
    return { merged, removed };
  }
}
