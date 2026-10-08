import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/main/app.js';
import type { MockProvider, MockTurn } from '../src/main/providers/adapters/mock.js';
import type { DeepPartial } from '../src/shared/types/config.js';
import type { AppEvent } from '../src/shared/types/events.js';

export interface TestApp {
  app: CoreApp;
  dir: string;
  mock: MockProvider;
  events: AppEvent[];
  cleanup(): Promise<void>;
}

/**
 * Boots the REAL CoreApp (SQLite, event bus, registry, agent, tools) in a
 * temp data dir with only the mock provider and no timers — this executes
 * the same code paths the Electron host uses.
 */
export async function makeTestApp(opts: { turns?: MockTurn[]; config?: DeepPartial<object>; writeScope?: boolean } = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'lpai-test-'));
  const app = new CoreApp({ dataDir: dir, adapters: 'mock-only', timers: false });
  const mock = app.providers.get('mock')?.adapter as MockProvider;
  for (const t of opts.turns ?? []) mock.pushScript(t);
  const patch: Record<string, unknown> = { indexing: { enabled: false }, ...(opts.config as Record<string, unknown>) };
  if (opts.writeScope) {
    patch.tools = { allowedRoots: [dir], readRoots: [dir], ...(patch.tools as object | undefined) };
  }
  app.config.patch(patch as DeepPartial<object> as never);
  await app.boot();
  const events: AppEvent[] = [];
  const unsub = app.bus.onAny((e) => events.push(e));
  return {
    app,
    dir,
    mock,
    events,
    cleanup: async () => {
      unsub();
      await app.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function eventsOfType(s: AppEvent[], type: string): AppEvent[] {
  return s.filter((e) => e.type === type);
}
