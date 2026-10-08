/**
 * Memory + context, end to end.
 *
 * What is really asserted here (and what is not):
 *   - memory written through the CHAT path ("remember that …") reaches the DB,
 *   - the next prompt the app sends to the model CONTAINS that memory
 *     (checked on the recorded request, not guessed from an answer),
 *   - memory survives a full app restart (same data dir, new process),
 *   - conversation history is included inside a conversation and NOT carried
 *     into a new conversation,
 *   - a matching memory outranks an unrelated one in the injected block.
 *
 * "Irrelevant context does not override a matching one" is asserted as the
 * ranking property it actually is (order inside the injected memory block);
 * asserting "the irrelevant memory is absent" would be wrong — the retrieval
 * budget can legitimately include low-scoring entries.
 */
import { expect, test } from '@playwright/test';
import { askViaUi, assistantBubbles, launchApp, waitForReady } from './harness.js';

interface MemoryEntry {
  id: string;
  content: string;
  type: string;
}

test.describe('Memory and context', () => {
  test('memory written in chat is injected into the next prompt and survives a restart', async (_fixtures, testInfo) => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    const dataDir = h.dataDir;
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'remember that the project codename is ZEPHYR-4417');
      await expect(assistantBubbles(h.page).last()).toBeVisible({ timeout: 45_000 });

      await expect
        .poll(
          async () => {
            const list = await h.invoke<MemoryEntry[]>('memory.list');
            return (list.data ?? []).some((m) => m.content.includes('ZEPHYR-4417'));
          },
          { timeout: 20_000, message: 'Memory wurde aus dem Chat heraus gespeichert' },
        )
        .toBe(true);

      // next question: the memory must travel to the model
      h.provider?.clear();
      await askViaUi(h.page, 'What is the project codename?');
      await expect.poll(() => h.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(h.provider?.sentText() ?? '', 'Memory im gesendeten Prompt').toContain('ZEPHYR-4417');

      await h.close({ keepProvider: true });

      // ---- restart with the SAME data dir: memory must still be there ----
      const h2 = await launchApp({ dataDir, emptyReply: '[e2e] ok' });
      try {
        await waitForReady(h2.page);
        const list = await h2.invoke<MemoryEntry[]>('memory.list');
        expect(
          (list.data ?? []).some((m) => m.content.includes('ZEPHYR-4417')),
          'Memory überlebt den Neustart',
        ).toBe(true);

        h2.provider?.clear();
        await askViaUi(h2.page, 'What is the project codename again?');
        await expect.poll(() => h2.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
        expect(h2.provider?.sentText() ?? '', 'Memory auch nach dem Neustart im Prompt').toContain('ZEPHYR-4417');
      } finally {
        await h2.attachDiagnostics(testInfo);
        await h2.close({ keepProvider: true });
      }
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close({ keepProvider: true });
    }
  });

  test('conversation history is used inside a conversation and stays out of a new one', async (_fixtures, testInfo) => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'My favourite colour is teal. Please confirm you noted it.');
      await expect(assistantBubbles(h.page).last()).toBeVisible({ timeout: 45_000 });

      // second turn in the SAME conversation -> history must be in the request
      h.provider?.clear();
      await askViaUi(h.page, 'Which colour did I mention? Answer in one word.');
      await expect.poll(() => h.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      const withHistory = h.provider?.sentText() ?? '';
      expect(withHistory, 'vorheriger Nutzerbeitrag im Prompt').toContain('favourite colour is teal');

      // a NEW conversation must not inherit that history
      h.provider?.clear();
      const fresh = await h.invoke('chat.send', { text: 'Which colour did I mention? Answer in one word.', mode: 'CHAT' });
      expect(fresh.ok).toBe(true);
      await expect.poll(() => h.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(h.provider?.sentText() ?? '', 'neue Konversation startet ohne alte Turns').not.toContain('favourite colour is teal');
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });

  test('a matching memory is ranked above an unrelated one in the injected context', async (_fixtures, testInfo) => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    try {
      await waitForReady(h.page);
      const relevant = 'the deployment window is every Thursday at 21:00';
      const unrelated = 'the office coffee machine needs descaling once a month';
      for (const content of [relevant, unrelated]) {
        const added = await h.invoke('memory.add', content, 'fact');
        expect(added.ok, `memory.add: ${content}`).toBe(true);
      }

      h.provider?.clear();
      await askViaUi(h.page, 'When is the deployment window?');
      await expect.poll(() => h.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      const sent = h.provider?.sentText() ?? '';
      const posRelevant = sent.indexOf('deployment window');
      const posUnrelated = sent.indexOf('coffee machine');
      expect(posRelevant, 'relevante Memory wurde injiziert').toBeGreaterThan(-1);
      if (posUnrelated > -1) {
        expect(posRelevant, 'relevante Memory steht vor der unpassenden').toBeLessThan(posUnrelated);
      }
    } finally {
      await h.attachDiagnostics(testInfo);
      await h.close();
    }
  });
});
