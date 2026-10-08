/**
 * Resource manager — spec §3.4/§40/§56. Samples CPU/RAM (and VRAM via the
 * Ollama /api/ps endpoint when a provider exposes it), drives LOW_RESOURCE /
 * BALANCED / PERFORMANCE modes, throttles background work under pressure.
 */
import { cpus, freemem, totalmem } from 'node:os';
import type { ResourceMode } from '../../shared/types/capabilities.js';
import { nowIso } from '../../shared/types/common.js';
import type { GpuSample, ResourceSnapshot } from '../../shared/types/diagnostics.js';
import type { AppBus } from '../../shared/types/events.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';
import type { BackgroundJobQueue } from '../indexing/backgroundQueue.js';

interface CpuTimes {
  idle: number;
  total: number;
}

export class ResourceManager {
  private lastCpu: CpuTimes | null = null;
  private cpuPercent: number | undefined;
  private timer: NodeJS.Timeout | null = null;
  private mode: ResourceMode = 'BALANCED';
  private gpus: GpuSample[] = [];
  private residentModelBytes: number | undefined;

  constructor(
    private config: ConfigService,
    private bus: AppBus,
    private log: SubLogger,
    private jobs: BackgroundJobQueue,
    /** Optional probe: provider registry can report resident models (Ollama /api/ps). */
    private providerProbe?: () => Promise<{ residentBytes: number; gpus: GpuSample[] } | null>,
  ) {}

  start(intervalMs = 5000): void {
    this.stop();
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sampleCpu(): number | undefined {
    const list = cpus();
    if (list.length === 0) return undefined;
    let idle = 0;
    let total = 0;
    for (const c of list) {
      idle += c.times.idle;
      total += Object.values(c.times).reduce((a, b) => a + b, 0);
    }
    const prev = this.lastCpu;
    this.lastCpu = { idle, total };
    if (!prev) return undefined;
    const dIdle = idle - prev.idle;
    const dTotal = total - prev.total;
    if (dTotal <= 0) return this.cpuPercent;
    return Math.round(100 * (1 - dIdle / dTotal));
  }

  async sample(): Promise<ResourceSnapshot> {
    this.cpuPercent = this.sampleCpu();
    try {
      const probe = await this.providerProbe?.();
      if (probe) {
        this.residentModelBytes = probe.residentBytes;
        this.gpus = probe.gpus;
      }
    } catch {
      /* provider offline — keep last-known */
    }
    const snap = this.snapshot();
    this.applyAutoMode(snap);
    return snap;
  }

  snapshot(): ResourceSnapshot {
    const total = totalmem();
    const free = freemem();
    return {
      sampledAt: nowIso(),
      cpuPercent: this.cpuPercent,
      memTotalMb: Math.round(total / 1024 / 1024),
      memUsedMb: Math.round((total - free) / 1024 / 1024),
      gpus: this.gpus.length > 0 ? this.gpus : undefined,
      residentModelBytes: this.residentModelBytes,
      resourceMode: this.mode,
      activeTasks: 0, // filled by container via taskManager
      indexingActive: this.jobs.active,
    };
  }

  currentMode(): ResourceMode {
    return this.mode;
  }

  /** User picks mode explicitly, or 'auto' re-enables the policy below. */
  setMode(mode: ResourceMode | 'auto'): ResourceMode {
    if (mode === 'auto') {
      this.config.patch({ performance: { autoSwitch: true } });
      this.log.info('resource management set to automatic');
      return this.mode;
    }
    this.config.patch({ performance: { autoSwitch: false, mode } });
    this.applyMode(mode, 'user selection');
    return mode;
  }

  private applyAutoMode(snap: ResourceSnapshot): void {
    const cfg = this.config.get();
    if (!cfg.performance.autoSwitch) {
      if (this.mode !== cfg.performance.mode) this.applyMode(cfg.performance.mode, 'manual setting');
      return;
    }
    const memPressure = snap.memUsedMb / Math.max(1, snap.memTotalMb);
    const lowRes = memPressure > 0.9 || (snap.cpuPercent !== undefined && snap.cpuPercent > 92);
    const headroom = memPressure < 0.75 && (snap.cpuPercent === undefined || snap.cpuPercent < 60);
    let target: ResourceMode = this.mode;
    if (lowRes && this.mode !== 'LOW_RESOURCE') target = 'LOW_RESOURCE';
    else if (headroom && this.mode === 'LOW_RESOURCE') target = 'BALANCED';
    if (target !== this.mode) this.applyMode(target, lowRes ? 'system pressure detected' : 'pressure relieved');
  }

  private applyMode(mode: ResourceMode, reason: string): void {
    this.mode = mode;
    this.config.patch({ performance: { mode } });
    // §40: LOW_RESOURCE pauses nonessential background services.
    this.jobs.setPaused(mode === 'LOW_RESOURCE');
    this.bus.emit({ type: 'resource.mode', mode, reason });
    this.log.info(`resource mode -> ${mode} (${reason})`);
  }

  /** Hint for the router in constrained mode (prefer smaller models). */
  preferSmallModels(): boolean {
    return this.mode === 'LOW_RESOURCE';
  }
}
