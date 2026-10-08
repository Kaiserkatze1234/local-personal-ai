/**
 * Chat surface: a normal question is answered and rendered, the answer streams
 * incrementally, Stop really cancels an in-flight generation, and a provider
 * error is shown honestly instead of being converted into a fake answer.
 *
 * The model behind the socket is scripted (tests/e2e/harness.ts) so every
 * assertion is deterministic; the app side is entirely real — router, context
 * engine, agent core, IPC, renderer.
 */
import { expect, test } from '@playwright/test';
import { askViaUi, assistantBubbles, bubbleText, launchApp, waitForReady } from './harness.js';

test.describe('Chat: answer, streaming, cancel, provider error', () => {
  test('a normal question is answered and the answer is exactly what the model returned', async (_fixtures, testInfo) => {
    const h = await launchApp({ replies: [{ text: 'Der Himmel ist blau.' }] });
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Warum ist der Himmel blau?');

      const bubbleLoc = assistantBubbles(h.page).last();
      await expect.poll(() => bubbleText(bubbleLoc), { timeout: 30_000 }).toBe('Der Himmel ist blau.');

      // the context lives in the REQUEST, not in the visible answer
      const sent = h.provider?.sentText() ?? '';
      expect(sent, 'System-Prompt/Context ging an das Modell').toContain('Warum ist der Himmel blau?');
      const bubble = await bubbleText(bubbleLoc);
      expect(bubble).not.toContain('[verification]');
      expect(bubble).not.toContain('"role"');
      expect(bubble).not.toContain('tool_call');

      // persisted turn is retrievable through the same IPC the UI uses
      const convos = await h.invoke<{ id: string }[]>('conversations.list');
      const convId = convos.data?.[0]?.id;
      expect(convId, 'Konversation wurde angelegt').toBeTruthy();
      const messages = await h.invoke<{ role: string; content: string }[]>('conversations.messages', convId);
      expect(messages.data?.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages.data?.[1]?.content).toBe('Der Himmel ist blau.');
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });

  test('streaming renders incrementally, not in one jump', async (_fixtures, testInfo) => {
    const full = `Hier ist eine längere Antwort, die Stück für Stück ankommt und am Ende vollständig sein muss. ${'Teil '.repeat(20)}ENDE-4417`;
    const h = await launchApp({ replies: [{ text: full, chunkSize: 10, chunkDelayMs: 120 }] });
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Erzähl mir etwas Langes.');

      const bubble = assistantBubbles(h.page).last();
      // an intermediate state must exist that is a strict prefix of the final text
      await expect.poll(() => bubbleText(bubble).then((t) => t.length), { timeout: 30_000 }).toBeGreaterThan(0);
      const partial = await bubbleText(bubble);
      expect(full.startsWith(partial), `Teiltext ist ein Präfix der Antwort: ${JSON.stringify(partial.slice(0, 60))}`).toBe(true);
      expect(partial.length, 'Antwort war zum Messzeitpunkt noch unvollständig').toBeLessThan(full.length);

      await expect.poll(() => bubbleText(bubble), { timeout: 60_000 }).toBe(full);
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });

  test('Stop cancels the running generation and the UI returns to a usable state', async (_fixtures, testInfo) => {
    const long = `Sehr lange Antwort die abgebrochen werden soll. ${'Weiter '.repeat(60)}NIE-ERREICHT`;
    const h = await launchApp({ replies: [{ text: long, chunkSize: 10, chunkDelayMs: 150 }] });
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Schreib einen langen Text.');

      const bubble = assistantBubbles(h.page).last();
      await expect.poll(() => bubbleText(bubble).then((t) => t.length), { timeout: 30_000 }).toBeGreaterThan(0);

      await h.page.locator('.composer button.danger').click(); // "Stop"
      await expect(h.page.locator('.composer button.primary')).toBeVisible({ timeout: 30_000 }); // Send wieder da

      const frozen = await bubbleText(bubble);
      await h.page.waitForTimeout(1200);
      const after = await bubbleText(bubble);
      expect(after.length, 'kein Weiterlaufen nach Stop').toBeLessThanOrEqual(frozen.length);
      expect(after).not.toContain('NIE-ERREICHT');
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });

  test('a provider error surfaces as an honest notice instead of a fabricated answer', async (_fixtures, testInfo) => {
    const h = await launchApp({ replies: [{ text: 'should never be shown', status: 500 }] });
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Beantworte das trotzdem.');

      const notice = h.page.locator('.notice').last();
      await expect(notice).toBeVisible({ timeout: 45_000 });
      await expect(notice).toContainText(/500|failed|generation/i);
      expect(await assistantBubbles(h.page).count(), 'kein erfundener Assistenten-Text').toBe(0);
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });
});
