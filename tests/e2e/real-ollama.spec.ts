/**
 * The one E2E spec that talks to the REAL local runtime.
 *
 * It is gated on an actual Ollama response (never on an env var alone, and it
 * is not a skip-for-convenience): if nothing answers on the endpoint the whole
 * suite is reported as SKIPPED with the reason, and the report says so — a
 * missing runtime is never counted as a pass. The chat role is bound to the
 * discovered chat-capable model through the app's normal config, so the app's
 * own router/adapter/context path does the work; nothing is mocked and no
 * second Ollama client is introduced.
 *
 * Embedding-only models are excluded by the same capability rule the product
 * uses (see pickChatModel).
 */
import { expect, test } from '@playwright/test';
import { askViaUi, assistantBubbles, bubbleText, launchApp, ollamaReachable, pickChatModel, waitForReady } from './harness.js';

const reach = await ollamaReachable();

test.describe('Real local runtime (Ollama)', () => {
  test.skip(
    !reach.ok,
    `Kein Ollama unter ${process.env.LPAI_OLLAMA_URL ?? 'http://127.0.0.1:11434'} (${reach.reason ?? 'kein Server'}) — Runtime-Tests bleiben SKIP, nicht PASS.`,
  );

  test('a real model answers a normal question promptly, without internal context leaking into the answer', async () => {
    const model = pickChatModel(reach.models);
    test.skip(!model, `Kein chat-fähiges Modell installiert (gefunden: ${reach.models.join(', ') || 'keine'})`);
    // a real model on a laptop CPU needs room; the suite timeout stays tight for the rest
    test.setTimeout(300_000);

    const token = 'E2E-OK-4417';
    // no scripted provider: the app talks to the real server through its own
    // Ollama adapter, bound via the normal role-override config
    const h = await launchApp({ withProvider: false, modelId: `ollama:${model}` });
    try {
      await waitForReady(h.page);

      const started = Date.now();
      await askViaUi(h.page, `Reply with exactly this token and nothing else: ${token}`);
      const bubble = assistantBubbles(h.page).last();
      await expect.poll(() => bubbleText(bubble), { timeout: 240_000, message: 'Antwort vom echten Modell' }).toContain(token);
      const elapsed = Date.now() - started;
      expect(elapsed, 'Antwort kam in vertretbarer Zeit').toBeLessThan(240_000);

      const answer = await bubbleText(bubble);
      // an answer is an answer — no prompt scaffolding, no tool frames, no JSON envelopes
      for (const marker of ['[verification]', '"role"', 'tool_call', '<|', 'system prompt', 'renderContextBlock', 'memory:']) {
        expect(answer, `Antwort enthält keinen internen Marker "${marker}"`).not.toContain(marker);
      }
      expect(answer.length, 'Antwort ist eine Antwort, kein Kontext-Dump').toBeLessThan(2000);
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close();
    }
  });
});
