/**
 * Proactive behavior — spec §27. Event-triggered, confidence-thresholded,
 * rate-limited, quiet-capable. Strong reasons only; annoyance by design is a
 * bug. Repeated user ignores mute a rule automatically.
 */
import { newId } from '../../shared/types/common.js';
import type { AppBus, AppEvent, ProactiveSuggestion } from '../../shared/types/events.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';

export interface NotifySink {
  notify(title: string, body: string): void;
}

interface Rule {
  id: string;
  /** Build a suggestion from a triggering event, or null to stay silent. */
  evaluate: (ev: AppEvent, ctx: ProactiveContext) => Omit<ProactiveSuggestion, 'id' | 'ruleId'> | null;
}

export interface ProactiveContext {
  recentIgnoreCounts: Map<string, number>;
  projectIdsWithActivity: Set<string>;
}

export class ProactiveService {
  private noticesThisHour: number[] = [];
  private ignoreCounts = new Map<string, number>();
  private mutedRules = new Set<string>();
  private lastDeliveredForKey = new Map<string, number>();
  private unsub: (() => void) | null = null;

  constructor(
    private bus: AppBus,
    private config: ConfigService,
    private log: SubLogger,
    private sink: NotifySink,
  ) {}

  start(): void {
    this.unsub?.();
    this.unsub = this.bus.onAny((ev) => this.onEvent(ev));
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private rules(): Rule[] {
    return [
      {
        id: 'build-failed',
        evaluate: (ev, ctx) => {
          if (ev.type !== 'build.failed') return null;
          const confidence = 0.85;
          if (!ctx.projectIdsWithActivity.has(ev.projectId ?? '')) return null; // only when the user works on it
          return {
            text: `A build just failed (${ev.command}). Want me to analyze the error and propose the smallest fix?`,
            reason: 'build failure on an active project',
            confidence,
            action: 'inline',
          };
        },
      },
      {
        id: 'task-waiting',
        evaluate: (ev) => {
          if (ev.type !== 'permission.requested') return null;
          return null; // the permission dialog itself is the notification — no duplicate nagging
        },
      },
      {
        id: 'provider-offline-on-task',
        evaluate: (ev, ctx) => {
          if (ev.type !== 'provider.status' || ev.health.state === 'OK') return null;
          if (!ctx.projectIdsWithActivity.size && !ctx.recentIgnoreCounts.size) {
            /* keep silent when idle — user may not care right now */
          }
          return {
            text: `Provider "${ev.health.providerId}" became unavailable: ${ev.health.message ?? 'no details'}. Tasks needing it are paused.`,
            reason: 'provider state change',
            confidence: 0.75,
            action: 'notify',
          };
        },
      },
      {
        id: 'long-background-done',
        evaluate: (ev) => {
          if (ev.type !== 'index.progress' || ev.done < ev.total) return null;
          if (!/(reindex|import)/i.test(ev.label)) return null;
          return {
            text: `Background work finished: ${ev.label}.`,
            reason: 'user-visible job completed',
            confidence: 0.95,
            action: 'silent',
          };
        },
      },
    ];
  }

  /** UI calls this after a task/project activity to mark attention context. */
  markProjectActive(projectId?: string): void {
    if (projectId) this.activeProjects.add(projectId);
    setTimeout(() => this.activeProjects.delete(projectId ?? ''), 15 * 60_000).unref?.();
  }
  private activeProjects = new Set<string>();

  /** User dismissed a suggestion => the rule falls in estimation (§27 restraint). */
  recordOutcome(ruleId: string, accepted: boolean): void {
    if (accepted) this.ignoreCounts.delete(ruleId);
    else {
      const n = (this.ignoreCounts.get(ruleId) ?? 0) + 1;
      this.ignoreCounts.set(ruleId, n);
      if (n >= 3) {
        this.mutedRules.add(ruleId);
        this.log.info(`proactive rule "${ruleId}" auto-muted after ${n} ignores`);
      }
    }
  }

  private onEvent(ev: AppEvent): void {
    const cfg = this.config.get().proactive;
    if (!cfg.enabled) return;
    if (this.inQuietHours(cfg.quietHours)) return;
    const now = Date.now();
    this.noticesThisHour = this.noticesThisHour.filter((t) => now - t < 3_600_000);
    if (this.noticesThisHour.length >= cfg.maxNoticesPerHour) return;

    const ctx: ProactiveContext = { recentIgnoreCounts: this.ignoreCounts, projectIdsWithActivity: this.activeProjects };
    for (const rule of this.rules()) {
      if (this.mutedRules.has(rule.id)) continue;
      let out: Omit<ProactiveSuggestion, 'id' | 'ruleId'> | null = null;
      try {
        out = rule.evaluate(ev, ctx);
      } catch (err) {
        this.log.debug(`proactive rule ${rule.id} threw: ${(err as Error).message}`);
        continue;
      }
      if (!out) continue;
      if (out.confidence < cfg.minConfidence) continue;
      const key = `${rule.id}:${ev.type}`;
      const last = this.lastDeliveredForKey.get(key) ?? 0;
      if (now - last < 60_000) continue; // dedupe bursts
      this.lastDeliveredForKey.set(key, now);
      const suggestion: ProactiveSuggestion = { ...out, id: newId('proc'), ruleId: rule.id };
      this.noticesThisHour.push(now);
      this.bus.emit({ type: 'proactive.suggestion', suggestion });
      if (suggestion.action === 'notify') {
        try {
          this.sink.notify('Local Personal AI', suggestion.text);
        } catch {
          /* notification APIs can fail silently; inline event already delivered */
        }
      }
      this.log.debug(`proactive: ${rule.id} (confidence ${suggestion.confidence})`);
    }
  }

  private inQuietHours(qh: { from: string; to: string } | null): boolean {
    if (!qh) return false;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const parse = (s: string): number => {
      const [h, m] = s.split(':').map((x) => Number.parseInt(x, 10));
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const from = parse(qh.from);
    const to = parse(qh.to);
    return from <= to ? mins >= from && mins <= to : mins >= from || mins <= to;
  }
}
