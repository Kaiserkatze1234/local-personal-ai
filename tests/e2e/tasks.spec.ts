/**
 * Tasks / "offene Punkte", end to end.
 *
 * Naming honesty: this application has no separate "OpenThreads" store. What it
 * has — and what the panel and the IPC surface expose — are TaskRecords (§9):
 * every substantial agent run, including a plain chat turn, is one. "Was habe
 * ich noch offen?" is therefore asserted against the REAL surface: the task
 * list, its statuses and its persistence across restarts. Nothing here invents
 * a thread subsystem that does not exist, and nothing asserts a fabricated
 * answer — the model behind the socket is scripted, the app is real.
 */
import { expect, test } from '@playwright/test';
import { askViaUi, assistantBubbles, bubbleText, launchApp, waitForReady } from './harness.js';

interface TaskRecord {
  id: string;
  title: string;
  userRequest: string;
  status: string;
}

const ACTIVE: string[] = ['queued', 'analyzing', 'executing', 'verifying', 'waiting_for_permission'];

test.describe('Open tasks', () => {
  test('a chat turn becomes a task record, nothing stays "running", and the record survives a restart', async () => {
    const h = await launchApp({ emptyReply: '[e2e] ok' });
    const dataDir = h.dataDir;
    let taskId: string | undefined;
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Was habe ich noch offen?');
      await expect(assistantBubbles(h.page).last()).toBeVisible({ timeout: 45_000 });

      const all = await h.invoke<TaskRecord[]>('tasks.list');
      expect(all.ok, 'tasks.list antwortet').toBe(true);
      expect(all.data?.length ?? 0, 'der Chat-Zug ist als Task erfasst').toBeGreaterThan(0);
      const mine = (all.data ?? []).find((t) => t.userRequest.includes('Was habe ich noch offen?'));
      expect(mine, 'genau dieser Zug ist als Task gespeichert').toBeTruthy();
      taskId = mine?.id;
      expect(mine?.status, 'ein abgeschlossener Chat-Turn ist completed').toBe('completed');

      // nothing may be left in a running state after the answer is complete —
      // a stuck task would show up in the UI as permanent activity
      const active = await h.invoke<TaskRecord[]>('tasks.list', ACTIVE);
      expect(active.ok).toBe(true);
      expect(active.data ?? [], 'keine Task bleibt nach dem Turn aktiv').toEqual([]);

      await h.close({ keepProvider: true });

      const h2 = await launchApp({ dataDir, emptyReply: '[e2e] ok' });
      try {
        await waitForReady(h2.page);
        const after = await h2.invoke<TaskRecord | null>('tasks.get', taskId);
        expect(after.ok).toBe(true);
        expect(after.data?.id).toBe(taskId);
        expect(after.data?.userRequest).toContain('Was habe ich noch offen?');
      } finally {
        await h2.attachDiagnostics(test.info());
        await h2.close({ keepProvider: true });
      }
    } finally {
      await h.attachDiagnostics(test.info());
      await h.close({ keepProvider: true });
    }
  });

  test('an interrupted run is recovered as paused after a hard restart (crash recovery)', async () => {
    const long = `Lange Antwort für den Absturztest. ${'Weiter '.repeat(80)}ENDE`;
    const h = await launchApp({ replies: [{ text: long, chunkSize: 8, chunkDelayMs: 60 }] });
    const dataDir = h.dataDir;
    const provider = h.provider;
    let bounced = false;
    try {
      await waitForReady(h.page);
      await askViaUi(h.page, 'Schreib bitte einen sehr langen Text.');
      const bubble = assistantBubbles(h.page).last();
      // as soon as text is flowing the task is really executing …
      await expect.poll(() => bubbleText(bubble).then((t) => t.length), { timeout: 30_000 }).toBeGreaterThan(0);

      // … and then the process dies the way a crash kills it (no graceful close)
      h.app.process().kill('SIGKILL');
      await expect.poll(() => h.app.process().exitCode, { timeout: 30_000 }).not.toBeNull();
      bounced = true;
    } finally {
      await provider?.stop();
      await h.attachDiagnostics(test.info());
      if (!bounced) await h.close({ keepProvider: true });
    }

    const h2 = await launchApp({ dataDir, emptyReply: '[e2e] ok' });
    try {
      await waitForReady(h2.page);
      const paused = await h2.invoke<TaskRecord[]>('tasks.list', ['paused']);
      expect(paused.ok).toBe(true);
      expect(paused.data?.length ?? 0, 'der abgebrochene Lauf ist als paused auffindbar').toBeGreaterThan(0);
      expect(paused.data?.[0]?.userRequest ?? '').toContain('langen Text');
      const active = await h2.invoke<TaskRecord[]>('tasks.list', ACTIVE);
      expect(active.data ?? [], 'nach dem Neustart läuft nichts mehr weiter').toEqual([]);
    } finally {
      await h2.attachDiagnostics(test.info());
      await h2.close({ keepProvider: true });
    }
  });
});
