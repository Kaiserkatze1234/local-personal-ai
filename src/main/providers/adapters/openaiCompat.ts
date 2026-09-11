/**
 * Generic OpenAI-compatible local endpoint adapter — spec §6
 * ("other local OpenAI-compatible servers"). LM Studio, llama.cpp server,
 * vLLM, LocalAI, … all speak this wire format.
 */

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
import { inferCapabilities } from './ollama.js';

export interface OpenAiCompatOptions {
  id?: string;
  label?: string;
  baseUrl: string; // e.g. http://127.0.0.1:1234/v1
  apiKey?: string; // only for optional non-local use; never logged
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatAdapter implements ModelProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  private apiKey?: string;
  private fetch: typeof fetch;

  constructor(opts: OpenAiCompatOptions) {
    this.id = opts.id ?? 'openai_compat';
    this.label = opts.label ?? 'OpenAI-compatible server';
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request(pathname: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as object) },
        signal: init.signal ?? ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      const res = await this.request('/models');
      if (!res.ok) return { providerId: this.id, state: 'ERROR', message: `HTTP ${res.status}`, checkedAt: nowIso() };
      const j = (await res.json()) as { data?: { id: string }[] };
      return {
        providerId: this.id,
        state: 'OK',
        message: `${j.data?.length ?? 0} model(s)`,
        latencyMs: Date.now() - t0,
        modelCount: j.data?.length ?? 0,
        checkedAt: nowIso(),
      };
    } catch {
      return { providerId: this.id, state: 'UNAVAILABLE', message: `Cannot reach ${this.baseUrl}`, checkedAt: nowIso() };
    }
  }

  async discoverModels(): Promise<ModelInfo[]> {
    const res = await this.request('/models');
    if (!res.ok) throw new Error(`Model discovery failed: HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { id: string; context_length?: number; supported_modalities?: string[] }[] };
    return (j.data ?? []).map((m) => {
      const caps = inferCapabilities(m.id);
      if (m.supported_modalities?.includes('image')) caps.push('vision');
      if (/(embed)/.test(m.id.toLowerCase()) && !caps.includes('embeddings')) caps.push('embeddings');
      return {
        id: `${this.id}:${m.id}`,
        providerId: this.id,
        name: m.id,
        contextLength: m.context_length ?? 4096,
        capabilities: [...new Set(caps)],
      };
    });
  }

  chat: ChatModelContract = {
    generate: async (req: GenerationRequest): Promise<GenerationResult> => {
      const model = req.modelId.replace(`${this.id}:`, '');
      const body: Record<string, unknown> = {
        model,
        messages: req.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) =>
                  p.type === 'text'
                    ? { type: 'text', text: p.text }
                    : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` } },
                ),
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
          ...(m.role === 'tool' && m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        })),
        stream: false,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.jsonMode) body.response_format = { type: 'json_object' };
      if (req.tools && req.tools.length > 0)
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      const res = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: req.signal }, 600_000);
      if (!res.ok) throw new Error(`Generation failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const j = (await res.json()) as {
        choices?: {
          message?: { content?: string; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = j.choices?.[0];
      const toolCalls: ToolCallSpec[] = (choice?.message?.tool_calls ?? []).map((tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          /* malformed args from weak models — keep empty + note */
        }
        return { id: tc.id ?? `call_${i}`, name: tc.function.name, args };
      });
      return {
        text: choice?.message?.content ?? '',
        toolCalls,
        usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : choice?.finish_reason === 'length' ? 'length' : 'stop',
      };
    },

    stream: async function* (this: OpenAiCompatAdapter, req: GenerationRequest): AsyncIterable<GenerationChunk> {
      const model = req.modelId.replace(`${this.id}:`, '');
      const res = await this.request(
        '/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify({
            model,
            messages: req.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')),
            })),
            stream: true,
            temperature: req.temperature,
          }),
          signal: req.signal,
        },
        600_000,
      );
      if (!res.ok || !res.body) throw new Error(`Stream failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) yield { textDelta: delta };
          } catch {
            /* partial */
          }
        }
      }
    }.bind(this),
  };

  embeddings: EmbeddingModelContract = {
    embed: async (modelId: string, texts: string[]): Promise<number[][]> => {
      const model = modelId.replace(`${this.id}:`, '');
      const res = await this.request('/embeddings', { method: 'POST', body: JSON.stringify({ model, input: texts }) }, 120_000);
      if (!res.ok) throw new Error(`Embeddings failed: HTTP ${res.status}`);
      const j = (await res.json()) as { data?: { embedding: number[] }[] };
      return (j.data ?? []).map((d) => d.embedding);
    },
  };
}
