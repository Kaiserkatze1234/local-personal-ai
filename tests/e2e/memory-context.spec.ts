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
import { askViaUi, assistantBubbles, bubbleText, launchApp, waitForReady } from './harness.js';

interface MemoryEntry {
  id: string;
  content: string;
  type: string;
}

test.describe('Memory and context', () => {
  test('memory written in chat is injected into the next prompt and survives a restart', async () => {
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
        await h2.attachDiagnostics(test.info());
        await h2.close({ keepProvider: true });
      }
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close({ keepProvider: true });
    }
  });

  test('conversation history is used inside a conversation and stays out of a new one', async () => {
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
      await h.attachDiagnostics(test.info());
      await h.close();
    }
  });

  test('a matching memory is ranked above an unrelated one in the injected context', async () => {
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
      await h.attachDiagnostics(test.info());
      await h.close();
    }
  });
});

test.describe('Memory and context: everyday scenarios from the specification', () => {
  test('"Merke dir: …" stores the preference and the next question recalls it', async () => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    const dataDir = h.dataDir;
    try {
      await waitForReady(h.page);
      // the exact German phrasing from the specification
      await askViaUi(h.page, 'Merke dir: Ich mag kurze Antworten.');
      await expect(assistantBubbles(h.page).last()).toBeVisible({ timeout: 45_000 });

      await expect
        .poll(async () => ((await h.invoke<MemoryEntry[]>('memory.list')).data ?? []).some((m) => m.content.includes('kurze Antworten')), {
          timeout: 20_000,
          message: 'Präferenz wurde als Memory gespeichert',
        })
        .toBe(true);

      h.provider?.clear();
      await askViaUi(h.page, 'Welche Art von Antworten mag ich?');
      await expect.poll(() => h.provider?.requests.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(h.provider?.sentText() ?? '', 'die gespeicherte Präferenz steht im Prompt').toContain('kurze Antworten');

      await h.close({ keepProvider: true });

      // and it is still there after a restart (persistence, not just session state)
      const h2 = await launchApp({ dataDir, emptyReply: '[e2e] ok' });
      try {
        await waitForReady(h2.page);
        const list = await h2.invoke<MemoryEntry[]>('memory.list');
        expect(
          (list.data ?? []).some((m) => m.content.includes('kurze Antworten')),
          'Präferenz überlebt den Neustart',
        ).toBe(true);
      } finally {
        await h2.attachDiagnostics(test.info());
        await h2.close({ keepProvider: true });
      }
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close({ keepProvider: true });
    }
  });

  test('a general question ("Erkläre mir Quantenphysik.") stays free of personal context', async () => {
    const answer = 'Quantenphysik beschreibt die Physik kleinster Teilchen und ihrer Wahrscheinlichkeiten.';
    const h = await launchApp({ emptyReply: answer });
    try {
      await waitForReady(h.page);
      const personal = 'Ich heiße Karsten und wohne in Walldorf.';
      expect((await h.invoke('memory.add', personal, 'fact')).ok, 'persönliche Memory gespeichert').toBe(true);

      h.provider?.clear();
      await askViaUi(h.page, 'Erkläre mir Quantenphysik.');

      const bubble = assistantBubbles(h.page).last();
      await expect.poll(() => bubbleText(bubble), { timeout: 30_000 }).toBe(answer);

      // the answer is an answer — not a dump of the personal context
      const visible = await bubbleText(bubble);
      for (const personalBit of ['Karsten', 'Walldorf', 'memory:', '[context]', 'Ich heiße']) {
        expect(visible, `die Antwort zeigt keine persönlichen Kontextdaten ("${personalBit}")`).not.toContain(personalBit);
      }
      // ... and an unrelated memory is not shipped to the model either
      const sent = h.provider?.sentText() ?? '';
      expect(sent).toContain('Quantenphysik');
      expect(sent, 'unpassende persönliche Memory bleibt draußen').not.toContain('Walldorf');
      // nothing personal anywhere on the chat surface
      expect(await h.page.locator('body').innerText(), 'keine persönliche Kontextliste im Chat').not.toContain('Walldorf');
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close();
    }
  });

  test('a past conversation is still retrievable after a restart', async () => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    const dataDir = h.dataDir;
    let convId: string | undefined;
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'The release train is called NIMBUS-2211.');
      await expect(assistantBubbles(h.page).last()).toBeVisible({ timeout: 45_000 });

      const convos = await h.invoke<{ id: string }[]>('conversations.list');
      convId = convos.data?.[0]?.id;
      expect(convId, 'Konversation existiert').toBeTruthy();

      await h.close({ keepProvider: true });

      const h2 = await launchApp({ dataDir, emptyReply: '[e2e] ok' });
      try {
        await waitForReady(h2.page);
        // the historical conversation is findable again ...
        const found = await h2.invoke<{ conversationId: string; snippet: string }[]>('conversations.search', 'NIMBUS-2211');
        expect(found.ok).toBe(true);
        expect(found.data?.length ?? 0, 'Suchtreffer in der alten Konversation').toBeGreaterThan(0);
        expect(found.data?.[0]?.conversationId).toBe(convId);
        // ... and its turns are complete
        const messages = await h2.invoke<{ role: string; content: string }[]>('conversations.messages', convId);
        expect(messages.ok).toBe(true);
        expect(messages.data?.some((m) => m.content.includes('NIMBUS-2211'))).toBe(true);
        expect(messages.data?.map((m) => m.role)).toContain('assistant');
      } finally {
        await h2.attachDiagnostics(test.info());
        await h2.close({ keepProvider: true });
      }
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close({ keepProvider: true });
    }
  });
});
