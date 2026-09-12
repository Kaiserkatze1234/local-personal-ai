/**
 * Shared numeric policy for generation limits — one source so the CONTEXT
 * assembler and the PROVIDER adapters can never drift apart (spec §29/§30
 * fit their prompt to a budget that must match the window actually requested
 * via num_ctx — see ollama.ts resolveNumCtx; real-Windows context bug class).
 */
import { totalmem } from 'node:os';

/** Context sizes below this are useless for tool loops; above the clamp, dangerous. */
export const MIN_NUM_CTX = 512;

/** Safe default when config carries no usable value. */
export const DEFAULT_NUM_CTX = 4096;

/** Coarse hardware ceiling for the runtime context based on installed RAM. */
export function hardwareContextCeiling(totalMemBytes = totalmem()): number {
  const gb = totalMemBytes > 0 ? totalMemBytes / 1024 ** 3 : 0;
  if (gb <= 0 || !Number.isFinite(gb)) return 8192; // unknown environment -> conservative
  if (gb < 8) return 4096;
  if (gb < 12) return 8192;
  if (gb < 24) return 16384; // a 16 GB laptop must not stream a 262k KV cache
  return 32768;
}

/** The runtime window an adapter will actually request: clamp(maybeInvalid, [MIN, ceiling]). */
export function clampRuntimeContext(requested: number | undefined, ceiling = hardwareContextCeiling()): number {
  const want = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_NUM_CTX;
  return Math.max(MIN_NUM_CTX, Math.min(want, Math.max(MIN_NUM_CTX, Math.floor(ceiling))));
}

/**
 * Effective prompt-fit budget for the context engine: whatever the user
 * configured, squeezed into the real window (prompt may never exceed what the
 * model will actually be given, minus headroom for the completion). Keeping
 * this next to clampRuntimeContext guarantees "budget: 8192" in the
 * transparency panel (§63) never describes a prompt Ollama would prune to 4k.
 */
export function effectivePromptBudget(
  configuredBudget: number,
  runtimeContextTokens: number,
  outputReserveFrac = 0.25,
  ceiling = hardwareContextCeiling(),
): number {
  const window = clampRuntimeContext(runtimeContextTokens, ceiling);
  const fit = Math.floor(window * (1 - Math.min(0.9, Math.max(0, outputReserveFrac))));
  const configured =
    typeof configuredBudget === 'number' && Number.isFinite(configuredBudget) && configuredBudget > 0
      ? Math.floor(configuredBudget)
      : DEFAULT_NUM_CTX;
  return Math.max(MIN_NUM_CTX, Math.min(configured, fit));
}
