/**
 * Configuration service — spec Phase 1.
 * JSON file in the data dir, atomic write (tmp + rename, §3.6), schema
 * defaults, event on change. External edits are ignored (single writer).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_CONFIG_VERSION } from '../../shared/constants.js';
import { type AppConfig, type DeepPartial, deepMergeConfig, defaultConfig } from '../../shared/types/config.js';
import { AppError } from './errors.js';

export class ConfigService {
  private config: AppConfig;
  private listeners = new Set<(c: AppConfig) => void>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.config = this.load();
  }

  private get path(): string {
    return join(this.dir, 'config.json');
  }

  private load(): AppConfig {
    const base = defaultConfig();
    if (!existsSync(this.path)) return base;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      const version = typeof raw.version === 'number' ? raw.version : 0;
      if (version > CURRENT_CONFIG_VERSION) {
        throw new AppError('invalid_state', `config.json version ${version} newer than supported ${CURRENT_CONFIG_VERSION}`);
      }
      // Unknown/extra keys are tolerated (forward-compatible); missing keys keep defaults.
      return deepMergeConfig(base, raw) as AppConfig;
    } catch (err) {
      // Corrupt config must not brick the app: keep defaults, preserve the broken file.
      console.error('[config] failed to parse config.json, using defaults:', (err as Error).message);
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return base;
    }
  }

  get(): Readonly<AppConfig> {
    return this.config;
  }

  patch(partial: DeepPartial<AppConfig>): AppConfig {
    this.config = deepMergeConfig(this.config, partial);
    this.scheduleSave();
    for (const fn of [...this.listeners]) fn(this.config);
    return this.config;
  }

  onChange(fn: (c: AppConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }

  /** Atomic write: temp file then rename (§3.6). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    renameSync(tmp, this.path);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }
}
