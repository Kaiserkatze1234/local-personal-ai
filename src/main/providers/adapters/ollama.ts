/**
 * Ollama adapter — an adapter, never the core (spec §6, RULE 8).
 * Talks to the local Ollama HTTP API via fetch; no SDK dependency.
 */
import { clampRuntimeContext, hardwareContextCeiling } from '../../../shared/util/limits.js';

// re-exported for existing imports/tests; the policy lives in shared/util/limits
export { hardwareContextCeiling, MIN_NUM_CTX } from '../../../shared/util/limits.js';

import type { ModelCapability } from '../../../shared/types/capabilities.js';
import { nowIso } from '../../../shared/types/common.js';
import type {
  ChatModelContract,
  EmbeddingModelContract,
  GenerationChunk,
  GenerationRequest,
  GenerationResult,
  ModelInfo,
  ModelProviderAdapter,
  ProviderHealth,
  ToolCallSpec,
} from '../../../shared/types/models.js';

export interface OllamaAdapterOptions {
  id?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Runtime context window policy (tokens). Advertise-max from model metadata
   * is NEVER used as a request default — qwen3-class models ship 262144 as
   * their Modelfile default, which makes Ollama allocate tens of GB of KV
   * cache on a laptop. defaultTokens may be a live getter (config-backed);
   * maxTokens is the hardware-sane clamp (defaults per installed RAM).
   */
  context?: { defaultTokens?: number | (() => number); maxTokens?: number | (() => number) };
}

function readLive(v: number | (() => number) | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'function' ? v() : v;
  return Number.isFinite(n) && n > 0 ? n : undefined; // 0/negative/NaN = unset -> safe default
}

interface OllamaTagModel {
  name: string;
  model?: string;
  size?: number;
  details?: { family?: string; parameter_size?: string; quantization_level?: string; parent_model?: string };
}

/** Heuristic capability inference from model name/family (documented, replaceable). */
export function inferCapabilities(name: string, family?: string): ModelCapability[] {
  const n = `${name} ${family ?? ''}`.toLowerCase();
  // Embedding-only models must NEVER advertise chat: Ollama lists models
  // alphabetically, so the old blanket 'text_generation' made every
  // capability-filtered picker (wizard scan, router, live tests) happily
  // select e.g. nomic-embed-text for /api/chat — a real Windows failure where
  // 'n' sorts before 'q'. bert-family counts as embedding-only too.
  const isEmbedding = /(embed|bge[-_]|jina|e5[-_]|[-_]e5|gte[-_]|snowflake-arctic|multilingual-e5|bert)/.test(n);
  const caps: ModelCapability[] = isEmbedding ? ['embeddings'] : ['text_generation', 'streaming'];
  if (!isEmbedding && /(vl|vision|llava|minicpm-v|gemma3|moondream|qwen2?\.5-vl|glm-4v)/.test(n)) caps.push('vision');
  if (
    !isEmbedding &&
    !/(llava|moondream)/.test(n) &&
    /(qwen2?(\.5)?|llama3(\.\d)?|mistral|mixtral|gemma3|deepseek|command-r|hermes|firefunction|nemotron|phi4|phi-4|granite)/.test(n)
  ) {
    caps.push('tool_calling');
  }
  if (!isEmbedding && /(qwen2?(\.5)?|llama3\.1|llama3\.2|mistral|mixtral|gemma3|deepseek|command-r|phi4|hermes)/.test(n))
    caps.push('structured_output');
  return caps;
}

function parameterCountB(size?: number, paramStr?: string): number | undefined {
  if (paramStr) {
    const m = /(\d+(?:\.\d+)?)B/i.exec(paramStr);
    if (m?.[1]) return Number.parseFloat(m[1]);
  }
  if (size) return Math.round((size / 2e9) * 10) / 10; // crude bytes→params
  return undefined;
}

export class OllamaAdapter implements ModelProviderAdapter {
  readonly id: string;
  readonly label = 'Ollama (local)';
  readonly baseUrl: string;
  private fetch: typeof fetch;
  private timeoutMs: number;
  private contextOpts: OllamaAdapterOptions['context'];
  private contextCache = new Map<string, number>();
  private thinkCapCache = new Map<string, boolean>();

  constructor(opts: OllamaAdapterOptions = {}) {
    this.id = opts.id ?? 'ollama';
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.contextOpts = opts.context;
  }

  /**
   * The one place num_ctx is decided: explicit per-request value wins over the
   * config default (4096 when unset); both are clamped into [MIN_NUM_CTX,
   * hardware ceiling]. Never derived from the model's advertised maximum.
   */
  private resolveNumCtx(req: GenerationRequest): number {
    const explicit =
      typeof req.contextTokens === 'number' && Number.isFinite(req.contextTokens) && req.contextTokens > 0 ? req.contextTokens : undefined;
    const ceiling = readLive(this.contextOpts?.maxTokens) ?? hardwareContextCeiling();
    return clampRuntimeContext(explicit ?? readLive(this.contextOpts?.defaultTokens), ceiling);
  }

  /**
   * Below this explicit maxTokens budget a thinking model reliably spends the
   * whole cap on reasoning and returns an EMPTY visible answer (real qwen3
   * failure: num_predict 64 -> content '' + done_reason 'length'), so bounded
   * short requests to thinking-capable models disable thinking for the request.
   */
  static readonly MIN_TOKENS_FOR_THINKING = 1024;

  /** /api/show `capabilities` (cached; missing/older shapes = not thinking-capable). */
  private async modelThinkingCapable(model: string): Promise<boolean> {
    const hit = this.thinkCapCache.get(model);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      const res = await this.request('/api/show', { method: 'POST', body: JSON.stringify({ name: model }) });
      if (res.ok) {
        const j = (await res.json()) as { capabilities?: unknown };
        ok = Array.isArray(j.capabilities) && j.capabilities.includes('thinking');
      }
    } catch {
      ok = false; // capability probe must never break generation
    }
    this.thinkCapCache.set(model, ok);
    return ok;
  }

  /** think:false ONLY for a small explicit cap on a thinking-capable model; otherwise untouched. */
  private async resolveThinkOpt(model: string, req: GenerationRequest): Promise<boolean | undefined> {
    const cap = req.maxTokens && req.maxTokens > 0 ? Math.floor(req.maxTokens) : 0;
    if (!cap || cap >= OllamaAdapter.MIN_TOKENS_FOR_THINKING) return undefined;
    return (await this.modelThinkingCapable(model)) ? false : undefined;
  }

  private async request(pathname: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    // Chained abort: BOTH the internal timeout and a caller-provided signal (user pressing
    // "stop") must cancel the HTTP request FOR ITS WHOLE LIFETIME — through the response
    // body of a stream, not just until headers arrive. A bridging listener that is removed
    // when the Response resolves silently disables Stop mid-stream (real live-suite failure:
    // generation ran on to the num_predict cap). AbortSignal.any keeps the composition
    // attached for as long as the fetch machinery consumes the body; the timeout therefore
    // also caps total stream duration — a stalled server can no longer hang the generator
    // forever. Node >=22 / Electron >=41 guarantee AbortSignal.any exists.
    const caller = init.signal as AbortSignal | null | undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : [])]);
    return this.fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      const res = await this.request('/api/tags');
      if (!res.ok) return { providerId: this.id, state: 'ERROR', message: `HTTP ${res.status}`, checkedAt: nowIso() };
      const json = (await res.json()) as { models?: OllamaTagModel[] };
      return {
        providerId: this.id,
        state: 'OK',
        message: `${json.models?.length ?? 0} model(s) available`,
        latencyMs: Date.now() - t0,
        modelCount: json.models?.length ?? 0,
        checkedAt: nowIso(),
      };
    } catch (_err) {
      return {
        providerId: this.id,
        state: 'UNAVAILABLE',
        message: `Cannot reach Ollama at ${this.baseUrl}. Start it ("ollama serve") or install it from https://ollama.com.`,
        checkedAt: nowIso(),
      };
    }
  }

  async discoverModels(): Promise<ModelInfo[]> {
    const res = await this.request('/api/tags');
    if (!res.ok) throw new Error(`Ollama model discovery failed: HTTP ${res.status}`);
    const json = (await res.json()) as { models?: OllamaTagModel[] };
    return (json.models ?? []).map((m) => {
      const name = m.model ?? m.name;
      return {
        id: `${this.id}:${name}`,
        providerId: this.id,
        name,
        family: m.details?.family,
        parameterCountB: parameterCountB(m.size, m.details?.parameter_size),
        quantization: m.details?.quantization_level,
        contextLength: this.contextCache.get(name) ?? 4096, // refined by /api/show on demand
        capabilities: inferCapabilities(name, m.details?.family),
        sizeBytes: m.size,
      };
    });
  }

  /** Fetch real context window once per model via /api/show. */
  async refineContext(modelName: string): Promise<number> {
    const cached = this.contextCache.get(modelName);
    if (cached) return cached;
    try {
      const res = await this.request('/api/show', { method: 'POST', body: JSON.stringify({ name: modelName }) });
      if (res.ok) {
        const j = (await res.json()) as { model_info?: Record<string, unknown> };
        // /api/show shapes differ across Ollama versions: current = FLAT dict with
        // family-prefixed keys ('qwen2.context_length'); older = nested one level
        // ({ llama: { 'llama.context_length': … } }). Search both, in order.
        const info = j.model_info ?? {};
        const flat = Object.entries(info).find(([k, v]) => k.endsWith('context_length') && typeof v === 'number' && v > 0);
        let n = typeof flat?.[1] === 'number' ? flat[1] : undefined;
        if (n === undefined) {
          for (const v of Object.values(info)) {
            if (v && typeof v === 'object') {
              const nested = Object.entries(v as Record<string, unknown>).find(([k]) => k.endsWith('context_length'));
              if (nested && typeof nested[1] === 'number' && nested[1] > 0) {
                n = nested[1];
                break;
              }
            }
          }
        }
        const resolved = n ?? 4096;
        this.contextCache.set(modelName, resolved);
        return resolved;
      }
    } catch {
      /* keep default */
    }
    return 4096;
  }

  private toOllamaMessages(req: GenerationRequest): unknown[] {
    return req.messages.map((m) => {
      const images: string[] = [];
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else {
        for (const part of m.content) {
          if (part.type === 'text') content += part.text;
          else images.push(part.dataBase64);
        }
      }
      const out: Record<string, unknown> = { role: m.role, content };
      if (images.length > 0) out.images = images;
      if (m.toolCalls && m.toolCalls.length > 0)
        out.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } }));
      if (m.role === 'tool' && m.toolCallId) out.role = 'tool';
      return out;
    });
  }

  chat: ChatModelContract = {
    generate: async (req: GenerationRequest): Promise<GenerationResult> => {
      const model = req.modelId.split(':').slice(1).join(':');
      const body: Record<string, unknown> = {
        model,
        messages: this.toOllamaMessages(req),
        stream: false,
        // num_ctx is ALWAYS explicit — an omitted value lets Ollama fall back
        // to the model's advertised maximum (e.g. 262144 → ~35 GB KV on a
        // laptop). undefined here previously vanished in JSON.stringify.
        options: {
          temperature: req.temperature,
          num_ctx: this.resolveNumCtx(req),
          // maxTokens is only a promise if it reaches the server (same bug class
          // as num_ctx: an omitted/undefined option silently means "unbounded")
          ...(req.maxTokens && req.maxTokens > 0 ? { num_predict: Math.floor(req.maxTokens) } : {}),
        },
      };
      if (req.keepAliveSec !== undefined) body.keep_alive = req.keepAliveSec;
      if (req.jsonMode) body.format = 'json';
      const genThink = await this.resolveThinkOpt(model, req);
      if (genThink !== undefined) body.think = genThink;
      if (req.tools && req.tools.length > 0)
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: req.signal }, 600_000);
      if (!res.ok) throw new Error(`Ollama generation failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const j = (await res.json()) as {
        done?: boolean;
        done_reason?: string;
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: { function: { name: string; arguments?: Record<string, unknown> } }[];
        };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const toolCalls: ToolCallSpec[] = (j.message?.tool_calls ?? []).map((tc, i) => ({
        id: `call_${Date.now()}_${i}`,
        name: tc.function.name,
        args: tc.function.arguments ?? {},
      }));
      // message.thinking is REAL generated content — keep it, but in its own
      // field: mixing it into text would show reasoning as the answer.
      const thinking = typeof j.message?.thinking === 'string' && j.message.thinking.length > 0 ? j.message.thinking : undefined;
      return {
        text: j.message?.content ?? '',
        ...(thinking ? { reasoning: thinking } : {}),
        toolCalls,
        usage: { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count },
        // the server states WHY it stopped — 'length' (truncated by num_predict)
        // must not be reported as a clean 'stop'
        finishReason: toolCalls.length > 0 ? 'tool_calls' : j.done_reason === 'length' ? 'length' : 'stop',
      };
    },

    stream: async function* (this: OllamaAdapter, req: GenerationRequest): AsyncIterable<GenerationChunk> {
      const model = req.modelId.split(':').slice(1).join(':');
      const body: Record<string, unknown> = {
        model,
        messages: this.toOllamaMessages(req),
        stream: true,
        // same guarantees as generate: bounded context AND bounded length —
        // a streamed story must not loop past its window forever
        options: {
          temperature: req.temperature,
          num_ctx: this.resolveNumCtx(req),
          ...(req.maxTokens && req.maxTokens > 0 ? { num_predict: Math.floor(req.maxTokens) } : {}),
        },
      };
      if (req.keepAliveSec !== undefined) body.keep_alive = req.keepAliveSec;
      const streamThink = await this.resolveThinkOpt(model, req);
      if (streamThink !== undefined) body.think = streamThink;
      const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: req.signal }, 600_000);
      if (!res.ok || !res.body) throw new Error(`Ollama stream failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          // belt & braces: deterministic exit even if the transport ignores the signal
          if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line) as { message?: { content?: string; thinking?: string }; done?: boolean; error?: string };
              if (j.error) throw new Error(`Ollama: ${j.error}`);
              const delta = j.message?.content ?? '';
              const reasoning = j.message?.thinking ?? '';
              if (delta || reasoning) yield { textDelta: delta, ...(reasoning ? { reasoningDelta: reasoning } : {}) };
            } catch (err) {
              if (err instanceof SyntaxError) continue; // partial line
              throw err;
            }
          }
        }
      } finally {
        // early consumer exit (UI Stop / break) must release the HTTP body,
        // otherwise the server keeps generating into an orphaned stream
        Promise.resolve(reader.cancel?.()).catch(() => {});
      }
    }.bind(this),
  };

  embeddings: EmbeddingModelContract = {
    embed: async (modelId: string, texts: string[]): Promise<number[][]> => {
      const model = modelId.split(':').slice(1).join(':');
      const res = await this.request('/api/embed', { method: 'POST', body: JSON.stringify({ model, input: texts }) }, 120_000);
      if (!res.ok) throw new Error(`Ollama embeddings failed: HTTP ${res.status}`);
      const j = (await res.json()) as { embeddings?: number[][] };
      return j.embeddings ?? [];
    },
  };

  async unloadModel(modelId: string): Promise<boolean> {
    try {
      const model = modelId.split(':').slice(1).join(':');
      await this.request(
        '/api/chat',
        { method: 'POST', body: JSON.stringify({ model, messages: [], stream: false, keep_alive: 0 }) },
        30_000,
      );
      return true;
    } catch {
      return false;
    }
  }
}
