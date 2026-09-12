/**
 * Ollama adapter — an adapter, never the core (spec §6, RULE 8).
 * Talks to the local Ollama HTTP API via fetch; no SDK dependency.
 */
import { totalmem } from 'node:os';

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

/** Context sizes below this are useless for tool loops; above the clamp, dangerous. */
export const MIN_NUM_CTX = 512;

/** Coarse hardware ceiling for the runtime context based on installed RAM. */
export function hardwareContextCeiling(totalMemBytes = totalmem()): number {
  const gb = totalMemBytes > 0 ? totalMemBytes / 1024 ** 3 : 0;
  if (gb <= 0 || !Number.isFinite(gb)) return 8192; // unknown environment -> conservative
  if (gb < 8) return 4096;
  if (gb < 12) return 8192;
  if (gb < 24) return 16384; // a 16 GB laptop must not stream a 262k KV cache
  return 32768;
}

function readLive(v: number | (() => number) | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'function' ? v() : v;
  return Number.isFinite(n) ? n : undefined;
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
  const caps: ModelCapability[] = ['text_generation', 'streaming'];
  if (/(vl|vision|llava|minicpm-v|gemma3|moondream|qwen2?\.5-vl|glm-4v)/.test(n)) caps.push('vision');
  if (/(embed|bge|snowflake-arctic|mxbai-embed|nomic-embed|jina-embed)/.test(n)) caps.push('embeddings');
  if (
    !/(embed|llava|bge|moondream)/.test(n) &&
    /(qwen2?(\.5)?|llama3(\.\d)?|mistral|mixtral|gemma3|deepseek|command-r|hermes|firefunction|nemotron|phi4|phi-4|granite)/.test(n)
  ) {
    caps.push('tool_calling');
  }
  if (/(qwen2?(\.5)?|llama3\.1|llama3\.2|mistral|mixtral|gemma3|deepseek|command-r|phi4|hermes)/.test(n)) caps.push('structured_output');
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
    const requested = req.contextTokens ?? readLive(this.contextOpts?.defaultTokens) ?? 4096;
    const ceiling = readLive(this.contextOpts?.maxTokens) ?? hardwareContextCeiling();
    return Math.max(MIN_NUM_CTX, Math.min(Math.floor(requested), Math.max(MIN_NUM_CTX, Math.floor(ceiling))));
  }

  private async request(pathname: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    // Chained abort: BOTH the internal timeout and a caller-provided signal
    // (user pressing "stop") must cancel the HTTP request — an abandoned
    // stream would otherwise leave the model generating and the GPU busy.
    // (Found by the real-Ollama live test: spreading `init` then setting
    // `signal` silently overrode the caller's signal.)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const caller = init.signal as AbortSignal | undefined | null;
    const onCallerAbort = (): void => ctrl.abort();
    caller?.addEventListener('abort', onCallerAbort);
    try {
      return await this.fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
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
      if (req.tools && req.tools.length > 0)
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: req.signal }, 600_000);
      if (!res.ok) throw new Error(`Ollama generation failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const j = (await res.json()) as {
        done?: boolean;
        message?: { content?: string; tool_calls?: { function: { name: string; arguments?: Record<string, unknown> } }[] };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const toolCalls: ToolCallSpec[] = (j.message?.tool_calls ?? []).map((tc, i) => ({
        id: `call_${Date.now()}_${i}`,
        name: tc.function.name,
        args: tc.function.arguments ?? {},
      }));
      return {
        text: j.message?.content ?? '',
        toolCalls,
        usage: { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
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
      const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: req.signal }, 600_000);
      if (!res.ok || !res.body) throw new Error(`Ollama stream failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string };
            if (j.error) throw new Error(`Ollama: ${j.error}`);
            const delta = j.message?.content ?? '';
            if (delta) yield { textDelta: delta };
          } catch (err) {
            if (err instanceof SyntaxError) continue; // partial line
            throw err;
          }
        }
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
