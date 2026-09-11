/**
 * Logger — spec §52. Structured, leveled, console + file sink.
 * Secrets are never written to logs (§35): values are redacted by pattern.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../../shared/types/config.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** key-like names that must never keep their value in a log line. */
const SECRET_KEY_RE =
  /([A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|authorization)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;}]{3,})/gi;
const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._+/=-]{8,})/gi;

export function redact(text: string): string {
  // bearer first: otherwise the key=... rule would eat "Bearer" and leak the token
  return text.replace(BEARER_RE, '$1•••REDACTED•••').replace(SECRET_KEY_RE, '$1•••REDACTED•••');
}

export interface LogEntry {
  at: string;
  subsystem: string;
  level: LogLevel;
  message: string;
  taskId?: string;
}

export interface LoggerOptions {
  level: LogLevel;
  /** When set, lines are also appended to <dir>/logs/app.log. */
  dir?: string;
  /** Forward structured entries (e.g. to the UI event bus). */
  onLog?: (entry: LogEntry) => void;
}

export class Logger {
  private filePath: string | null = null;
  private lastRotateCheck = 0;

  constructor(private opts: LoggerOptions) {
    if (opts.dir) {
      const logsDir = join(opts.dir, 'logs');
      mkdirSync(logsDir, { recursive: true });
      this.filePath = join(logsDir, 'app.log');
    }
  }

  setLevel(level: LogLevel): void {
    this.opts.level = level;
  }

  child(subsystem: string): SubLogger {
    return new SubLogger(this, subsystem);
  }

  log(subsystem: string, level: LogLevel, message: string, taskId?: string): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const clean = redact(message);
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${subsystem}]${taskId ? ` {${taskId}}` : ''} ${clean}`;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line);
    this.opts.onLog?.({ at: new Date().toISOString(), subsystem, level, message: clean, taskId });
    if (this.filePath) {
      this.maybeRotate();
      try {
        appendFileSync(this.filePath, `${line}\n`);
      } catch {
        /* logging must never break the app */
      }
    }
  }

  /** Crude size cap so a runaway debug level cannot fill the disk. */
  private maybeRotate(): void {
    const now = Date.now();
    if (now - this.lastRotateCheck < 30_000 || !this.filePath) return;
    this.lastRotateCheck = now;
    try {
      const st = statSync(this.filePath);
      if (st.size > 5 * 1024 * 1024) {
        const all = readFileSync(this.filePath, 'utf8').split('\n');
        const keep = all.slice(-500).join('\n');
        // rewrite keeping the tail (non-atomic is acceptable for logs)
        writeFileSync(this.filePath, `${keep}\n--- log truncated (size cap 5MB) ---\n`);
      }
    } catch {
      /* ignore */
    }
  }

  tail(maxLines = 400): string[] {
    if (!this.filePath) return [];
    try {
      return readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean).slice(-maxLines);
    } catch {
      return [];
    }
  }
}

export class SubLogger {
  constructor(
    private parent: Logger,
    private subsystem: string,
  ) {}

  private emit(level: LogLevel, msg: string, taskId?: string): void {
    this.parent.log(this.subsystem, level, msg, taskId);
  }
  debug(msg: string, taskId?: string): void {
    this.emit('debug', msg, taskId);
  }
  info(msg: string, taskId?: string): void {
    this.emit('info', msg, taskId);
  }
  warn(msg: string, taskId?: string): void {
    this.emit('warn', msg, taskId);
  }
  error(msg: string, taskId?: string): void {
    this.emit('error', msg, taskId);
  }
}
