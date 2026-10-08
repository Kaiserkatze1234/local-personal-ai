/**
 * Background work queue — spec §41: cancellable, resource-aware, prioritized,
 * visible (progress events), never starves the foreground.
 */

import { newId } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { SubLogger } from '../core/logger.js';

export interface Job {
  id: string;
  label: string;
  priority: number; // higher first
  run: () => Promise<unknown>;
  onCancel?: () => void;
}

export class BackgroundJobQueue {
  private queue: Job[] = [];
  private running = 0;
  private paused = false;
  private concurrency = 1;

  constructor(
    private bus: AppBus,
    private log: SubLogger,
  ) {}

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(4, n));
    this.pump();
  }

  private generationBusy = false;

  /** True while a model generation holds the foreground (§55). */
  isGenerationBusy(): boolean {
    return this.generationBusy;
  }

  /** §40: LOW_RESOURCE mode or an active generation pauses background work. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.pump();
  }

  setGenerationBusy(busy: boolean): void {
    this.generationBusy = busy;
    this.setPaused(busy);
  }

  get active(): boolean {
    return this.running > 0;
  }

  enqueue(job: Omit<Job, 'id'> & { id?: string }): string {
    const id = job.id ?? newId('job');
    this.queue.push({ ...job, id });
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
    return id;
  }

  cancel(jobId: string): boolean {
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      job?.onCancel?.();
      return true;
    }
    return false;
  }

  stats(): { queued: number; running: number; paused: boolean } {
    return { queued: this.queue.length, running: this.running, paused: this.paused };
  }

  /** Wait for the queue to drain (tests + post-import processing). */
  async drain(timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while ((this.running > 0 || this.queue.length > 0) && Date.now() - t0 < timeoutMs) {
      if (this.paused) this.setPaused(false);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private pump(): void {
    while (!this.paused && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift() as Job;
      this.running++;
      this.bus.emit({ type: 'index.progress', jobId: job.id, done: 0, total: 1, label: job.label });
      void (async () => {
        try {
          await job.run();
        } catch (err) {
          this.log.warn(`background job "${job.label}" failed: ${(err as Error).message}`);
        } finally {
          this.running--;
          this.bus.emit({ type: 'index.progress', jobId: job.id, done: 1, total: 1, label: `${job.label} (done)` });
          this.pump();
        }
      })();
    }
  }
}
