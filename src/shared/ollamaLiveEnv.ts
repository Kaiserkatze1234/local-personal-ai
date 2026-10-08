/**
 * Single source of truth for live-test activation (used by
 * tests/ollama-live.test.ts; no production runtime reads this).
 * Documented in README "Verify a real install".
 */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'; // mirrors src/main/app.ts auto-discovery

export interface LiveActivation {
  on: boolean;
  baseUrl: string;
  why: string;
}

/** Deterministic precedence: explicit flag > explicit off > legacy URL > default off. */
export function ollamaLiveActivation(env: Record<string, string | undefined>): LiveActivation {
  const url = env.LPAI_OLLAMA_URL?.trim();
  const flag = env.LPAI_LIVE_OLLAMA?.trim().toLowerCase();
  if (flag && flag !== '0' && flag !== 'false' && flag !== 'off') {
    return { on: true, baseUrl: url || DEFAULT_OLLAMA_URL, why: 'LPAI_LIVE_OLLAMA' };
  }
  if (flag === '0' || flag === 'false' || flag === 'off') {
    return { on: false, baseUrl: url || DEFAULT_OLLAMA_URL, why: 'LPAI_LIVE_OLLAMA explicitly disabled (overrides LPAI_OLLAMA_URL)' };
  }
  if (url) return { on: true, baseUrl: url, why: 'LPAI_OLLAMA_URL (legacy/endpoint-override activation)' };
  return { on: false, baseUrl: DEFAULT_OLLAMA_URL, why: 'set LPAI_LIVE_OLLAMA=1 (endpoint via LPAI_OLLAMA_URL is optional)' };
}
