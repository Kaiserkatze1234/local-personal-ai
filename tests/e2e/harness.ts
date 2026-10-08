/**
 * E2E harness: launches the REAL Electron app (built dist/) through Playwright
 * and gives the specs three things they need to be honest and deterministic:
 *
 *  1. Isolation — every launch gets its own temp data dir (`LPAI_DATA_DIR`,
 *     which since this pass also drives Electron's userData, so window state
 *     and the single-instance lock are isolated too). The production data dir
 *     (`%APPDATA%\lpai`) is never touched, never read.
 *
 *  2. A scripted provider — a tiny HTTP server that speaks the SAME
 *     OpenAI-compatible wire format the app already supports
 *     (`LPAI_OPENAI_BASE_URL`), so Chat/streaming/context tests are
 *     deterministic and need no Ollama. Nothing is mocked inside the app: the
 *     real adapter, the real router, the real context engine and the real
 *     renderer are exercised; only the model on the other end of the socket is
 *     ours. Every request is recorded, which is how the context tests can
 *     assert what the app actually sent (history, memory) instead of guessing
 *     from the answer.
 *
 *  3. Diagnostics — renderer console/page errors and the main-process log are
 *     collected and attached to the test, so a failing run leaves evidence
 *     (screenshot/trace come from Playwright's config).
 *
 * Ollama does not have to be installed for any of this; the one spec that
 * needs the real server skips itself when nothing answers on the endpoint.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, _electron as electron, type Locator, type Page, type TestInfo } from '@playwright/test';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OLLAMA_BASE_URL = (process.env.LPAI_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

export interface ScriptedReply {
  text: string;
  /** delay between streamed chunks; makes incremental rendering observable */
  chunkDelayMs?: number;
  /** characters per streamed chunk */
  chunkSize?: number;
  /** force an HTTP error status (adapter/provider error paths) */
  status?: number;
}

interface RecordedRequest {
  url: string;
  stream: boolean;
  model?: string;
  messages: { role: string; content: unknown }[];
  raw: string;
}

const DEFAULT_CHUNK_SIZE = 12;

/** Minimal OpenAI-compatible endpoint: /v1/models + /v1/chat/completions (stream & non-stream). */
export class ScriptedProvider {
  private server: Server | null = null;
  private replies: ScriptedReply[] = [];
  private fallbackReply: string | null = null;
  readonly requests: RecordedRequest[] = [];
  port = 0;
  readonly modelName = 'scripted-1';

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Queue answers for the next requests (FIFO). */
  script(replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  /** Answer used when the queue is empty. */
  onEmpty(text: string | null): void {
    this.fallbackReply = text;
  }

  clear(): void {
    this.replies = [];
    this.requests.length = 0;
  }

  lastRequest(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  /** Every prompt content the app sent, as one searchable string. */
  sentText(index = -1): string {
    const req = index < 0 ? this.requests.at(this.requests.length + index) : this.requests[index];
    if (!req) return '';
    return req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';

    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: this.modelName, object: 'model', owned_by: 'e2e' }] }));
      return;
    }

    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      let body: { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* malformed: recorded raw below */
      }
      this.requests.push({ url, stream: Boolean(body.stream), model: body.model, messages: body.messages ?? [], raw });
      const reply = this.replies.shift();
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      const text = reply?.text ?? this.fallbackReply ?? `[e2e] received: ${lastUserText.slice(0, 120)}`;

      if (reply?.status && reply.status >= 400) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `scripted failure ${reply.status}` } }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const size = reply?.chunkSize ?? DEFAULT_CHUNK_SIZE;
        const delay = reply?.chunkDelayMs ?? 0;
        for (let i = 0; i < text.length; i += size) {
          if (res.writableEnded || res.destroyed) return; // client aborted (Stop button, app quit)
          const delta = text.slice(i, i + size);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
        if (!res.writableEnded && !res.destroyed) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          model: body.model ?? this.modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
  }
}

/** Config written before launch: wizard done, scripted model bound to every chat role. */
export function e2eConfig(modelId: string): Record<string, unknown> {
  const roles = ['chat', 'coding', 'planning', 'review', 'summarization', 'compression', 'prompt_assistant'];
  return {
    version: 1,
    general: { language: 'en', theme: 'dark', startHidden: false, autostart: false, closeToTray: false },
    ai: { routingOverride: Object.fromEntries(roles.map((r) => [r, modelId])), temperature: 0 },
    wizard: { completed: true },
    indexing: { enabled: false },
    voice: { enabled: false },
    overlay: { enabled: false },
    proactive: { enabled: false },
    promptAssistant: { enabled: false },
    memory: { enabled: true, requireReview: false, compressionEnabled: false },
    diagnostics: { logLevel: 'info' },
    tools: { permissionMode: 'SAFE' },
    performance: { mode: 'BALANCED', autoSwitch: false, pauseIndexingDuringGeneration: false, modelIdleUnloadMinutes: 0 },
  };
}

export interface LaunchOptions {
  /** reuse an existing data dir (restart/persistence tests) */
  dataDir?: string;
  replies?: ScriptedReply[];
  /** fallback answer when the queue is empty */
  emptyReply?: string | null;
  config?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
  /** start the scripted provider (default true) */
  withProvider?: boolean;
  /** bind every chat-capable role to this model id (default: the scripted provider's) */
  modelId?: string;
}

export interface Harness {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  provider: ScriptedProvider | null;
  modelId: string;
  consoleLines: string[];
  pageErrors: string[];
  /** IPC round-trip through the real preload bridge, exactly like the renderer does */
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<{ ok: boolean; data?: T; error?: { message?: string } }>;
  /** send a chat message through the real send() path the UI uses */
  sendChat(text: string, opts?: { mode?: string; conversationId?: string }): Promise<void>;
  close(opts?: { keepProvider?: boolean }): Promise<void>;
  attachDiagnostics(info: TestInfo): Promise<void>;
  appLogPath(): string;
}

export async function launchApp(o: LaunchOptions = {}): Promise<Harness> {
  const ownsDataDir = !o.dataDir;
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'lpai-e2e-'));
  const withProvider = o.withProvider !== false;
  const provider = withProvider ? new ScriptedProvider() : null;
  if (provider) {
    await provider.start();
    provider.script(o.replies ?? []);
    provider.onEmpty(o.emptyReply ?? null);
  }
  const modelId = o.modelId ?? `openai_compat:${provider?.modelName ?? 'scripted-1'}`;
  if (ownsDataDir || !existsSync(join(dataDir, 'config.json'))) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...e2eConfig(modelId), ...(o.config ?? {}) }, null, 2));
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LPAI_DATA_DIR: dataDir,
    ...(provider ? { LPAI_OPENAI_BASE_URL: provider.baseUrl } : {}),
    ...(o.extraEnv ?? {}),
  };

  const app = await electron.launch({ args: ['.'], cwd: REPO_ROOT, env });
  const page = await app.firstWindow();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const harness: Harness = {
    app,
    page,
    dataDir,
    provider,
    modelId,
    consoleLines,
    pageErrors,
    invoke: <T>(method: string, ...args: unknown[]) =>
      page.evaluate(
        ({ m, a }: { m: string; a: unknown[] }) => {
          const bridge = (globalThis as { lpai?: { invoke?: (x: string, ...y: unknown[]) => Promise<unknown> } }).lpai;
          if (!bridge?.invoke) throw new Error('preload bridge missing');
          return bridge.invoke(m, ...a) as Promise<{ ok: boolean; data?: T; error?: { message?: string } }>;
        },
        { m: method, a: args },
      ) as Promise<{ ok: boolean; data?: T; error?: { message?: string } }>,
    sendChat: async (text, opts = {}) => {
      const res = await harness.invoke('chat.send', {
        text,
        mode: opts.mode ?? 'CHAT',
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      });
      if (!res.ok) throw new Error(`chat.send failed: ${res.error?.message ?? 'unknown'}`);
    },
    close: async (opts = {}) => {
      try {
        await app.close();
      } catch {
        /* already gone */
      }
      if (!opts.keepProvider) await provider?.stop();
      if (ownsDataDir && !opts.keepProvider) rmSync(dataDir, { recursive: true, force: true });
    },
    attachDiagnostics: async (info: TestInfo) => {
      await info.attach('renderer-console.log', { body: consoleLines.join('\n') || '(no console output)', contentType: 'text/plain' });
      await info.attach('renderer-errors.log', { body: pageErrors.join('\n') || '(no page errors)', contentType: 'text/plain' });
      const logPath = join(dataDir, 'logs', 'app.log');
      if (existsSync(logPath)) await info.attach('main-process.log', { path: logPath, contentType: 'text/plain' });
      else await info.attach('main-process.log', { body: '(no app.log written)', contentType: 'text/plain' });
    },
    appLogPath: () => join(dataDir, 'logs', 'app.log'),
  };
  return harness;
}

/**
 * Waits until the renderer is past boot: config loaded, wizard done, composer
 * visible. No fixed sleeps — Playwright waits for the real element state.
 */
export async function waitForReady(page: Page): Promise<void> {
  await page.locator('.composer textarea').waitFor({ state: 'visible', timeout: 30_000 });
}

export function assistantBubbles(page: Page) {
  return page.locator('.msg.assistant .bubble');
}

/**
 * The answer text of an assistant bubble.
 *
 * The bubble also hosts small controls (today: the "read aloud" button that
 * appears once an answer is complete). Those are UI, not model output — every
 * assertion about WHAT THE MODEL SAID goes through this helper, so a new
 * control in the bubble can never silently turn into a wrong answer.
 */
export async function bubbleText(bubble: Locator): Promise<string> {
  const raw = await bubble.innerText();
  return raw
    .split(/\r?\n/)
    .filter((l) => !/^\s*🔊/.test(l))
    .join('\n')
    .trim();
}

export function userBubbles(page: Page) {
  return page.locator('.msg.user .bubble');
}

/** Ask through the real UI (typing + Enter) — this is what a user does. */
export async function askViaUi(page: Page, text: string): Promise<void> {
  const box = page.locator('textarea');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

export async function lastAssistantText(page: Page): Promise<string> {
  const bubbles = assistantBubbles(page);
  const n = await bubbles.count();
  if (n === 0) return '';
  return bubbleText(bubbles.nth(n - 1));
}

/** The app writes its log next to the data dir — surfaced for failure triage. */
export function readAppLog(dataDir: string, maxLines = 80): string {
  const p = join(dataDir, 'logs', 'app.log');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').split(/\r?\n/).slice(-maxLines).join('\n');
}

/** Real Ollama reachability check used to decide SKIP vs run for the live spec. */
export async function ollamaReachable(timeoutMs = 3000): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, models: [], reason: `HTTP ${res.status}` };
    const j = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, models: (j.models ?? []).map((m) => m.name).filter(Boolean) };
  } catch (err) {
    return { ok: false, models: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Chat-capable pick for the live spec (never an embedding-only model). */
export function pickChatModel(models: string[]): string | null {
  const isEmbed = (n: string) => /(embed|bge[-_]|jina|e5[-_]|gte[-_]|snowflake-arctic|bert)/i.test(n);
  const cap = (n: string) => (n.endsWith(':latest') ? n.slice(0, -':latest'.length) : n);
  const pinned = process.env.LPAI_OLLAMA_MODEL;
  if (pinned) {
    const found = models.find((m) => m === pinned || cap(m) === cap(pinned));
    if (!found) throw new Error(`LPAI_OLLAMA_MODEL='${pinned}' ist nicht installiert (gefunden: ${models.join(', ') || 'keine'})`);
    return found;
  }
  const chat = models.filter((m) => !isEmbed(m));
  return chat.includes('qwen3:4b') ? 'qwen3:4b' : (chat[0] ?? null);
}
