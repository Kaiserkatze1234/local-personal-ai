/** Application configuration — settings groups mirror spec §47. */
import type { ModelRole, PermissionMode, ResourceMode } from './capabilities.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  /** Config schema version; used for future migrations. */
  version: number;
  general: {
    language: string;
    theme: 'dark' | 'light' | 'system';
    startHidden: boolean;
  };
  ai: {
    /** Default context budget for chat-style tasks (tokens, estimated). */
    contextTokenBudget: number;
    agentContextTokenBudget: number;
    temperature: number;
    /** User routing overrides: role -> modelId (null clears). */
    routingOverride: Partial<Record<ModelRole, string>>;
    /** When true, allow routing to remote endpoints the user configured. */
    allowRemoteProviders: boolean;
  };
  memory: {
    enabled: boolean;
    retentionDays: number;
    compressionEnabled: boolean;
    /** Candidate memories need explicit user confirmation (§18). */
    requireReview: boolean;
    /** Above this many stored entries, maintenance may run in background. */
    compressionThreshold: number;
  };
  tools: {
    permissionMode: PermissionMode;
    /** Absolute dirs the file tools may touch. Empty = nothing writable. */
    allowedRoots: string[];
    /** Read scope can be wider than write scope; empty = same as allowedRoots. */
    readRoots: string[];
    commandTimeoutSec: number;
  };
  vision: {
    enabled: boolean;
    /** Ephemeral by default: do not keep screenshots (§21). */
    persistScreenshots: boolean;
  };
  screen: {
    /** Continuous capture must be explicitly enabled by the user (§21). */
    continuousEnabled: boolean;
    intervalMs: number;
  };
  voice: {
    enabled: boolean;
    sttModel: string | null;
    ttsModel: string | null;
    pushToTalkHotkey: string;
    speed: number;
    volume: number;
  };
  overlay: {
    enabled: boolean;
    position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
    opacity: number;
    hotkey: string;
    lowResourceMode: boolean;
  };
  performance: {
    mode: ResourceMode;
    /** Auto-switch modes when pressure is detected (§40). */
    autoSwitch: boolean;
    backgroundConcurrency: number;
    pauseIndexingDuringGeneration: boolean;
  };
  promptAssistant: {
    enabled: boolean;
    debounceMs: number;
    /** Use a (small) model pass in addition to heuristics when available. */
    useModel: boolean;
  };
  proactive: {
    enabled: boolean;
    minConfidence: number;
    /** Max proactive notices per hour (§27 restraint). */
    maxNoticesPerHour: number;
    quietHours: { from: string; to: string } | null;
  };
  personality: {
    verbosity: 'concise' | 'balanced' | 'detailed';
    formality: 'formal' | 'casual';
    technicalDepth: 'simple' | 'standard' | 'deep';
  };
  indexing: {
    enabled: boolean;
    /** Directories the user explicitly chose to index (§31 — never assume). */
    roots: string[];
    excludeDirs: string[];
  };
  diagnostics: {
    logLevel: LogLevel;
  };
  wizard: {
    completed: boolean;
  };
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    general: { language: 'de', theme: 'dark', startHidden: false },
    ai: {
      contextTokenBudget: 6000,
      agentContextTokenBudget: 10000,
      temperature: 0.7,
      routingOverride: {},
      allowRemoteProviders: false,
    },
    memory: {
      enabled: true,
      retentionDays: 0,
      compressionEnabled: true,
      requireReview: true,
      compressionThreshold: 80,
    },
    tools: {
      permissionMode: 'BALANCED',
      allowedRoots: [],
      readRoots: [],
      commandTimeoutSec: 120,
    },
    vision: { enabled: true, persistScreenshots: false },
    screen: { continuousEnabled: false, intervalMs: 5000 },
    voice: {
      enabled: false,
      sttModel: null,
      ttsModel: null,
      pushToTalkHotkey: 'Ctrl+Alt+V',
      speed: 1,
      volume: 1,
    },
    overlay: {
      enabled: false,
      position: 'bottom-right',
      opacity: 0.92,
      hotkey: 'Ctrl+Alt+O',
      lowResourceMode: true,
    },
    performance: {
      mode: 'BALANCED',
      autoSwitch: true,
      backgroundConcurrency: 1,
      pauseIndexingDuringGeneration: true,
    },
    promptAssistant: { enabled: true, debounceMs: 450, useModel: false },
    proactive: {
      enabled: true,
      minConfidence: 0.7,
      maxNoticesPerHour: 3,
      quietHours: null,
    },
    personality: { verbosity: 'balanced', formality: 'casual', technicalDepth: 'standard' },
    indexing: {
      enabled: true,
      roots: [],
      excludeDirs: [
        'node_modules',
        '.git',
        'dist',
        'build',
        'out',
        'target',
        '__pycache__',
        '.venv',
        'venv',
        '.cache',
        'AppData',
        'Downloads',
        'Downloads/*',
      ],
    },
    diagnostics: { logLevel: 'info' },
    wizard: { completed: false },
  };
}

/** Recursive partial used for config patch requests. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `patch` (deep, object levels only) onto `base`, returning a new object. */
export function deepMergeConfig<T extends object>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return { ...base };
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMergeConfig(cur as object, v) : v;
  }
  return out as T;
}
