/**
 * Mock/adapter provider — used by (a) tests and (b) the built-in "demo model"
 * so the app can chat and run agents before the user installs a runtime.
 * It is explicitly labeled; the app never pretends the demo model is real AI.
 */

import { ALL_MODEL_CAPABILITIES } from '../../../shared/types/capabilities.js';
import { nowIso } from '../../../shared/types/common.js';
import type {
  ChatModelContract,
  GenerationChunk,
  GenerationRequest,
  GenerationResult,
  ModelInfo,
  ModelProviderAdapter,
  ProviderHealth,
  ToolCallSpec,
} from '../../../shared/types/models.js';

export type MockTurn = string | { text?: string; toolCalls?: ToolCallSpec[]; chunks?: string[]; error?: string };

export interface MockProviderOptions {
  id?: string;
  label?: string;
  modelName?: string;
  /** Capabilities to advertise; default: everything. */
  capabilities?: ModelInfo['capabilities'];
  contextLength?: number;
  /** Scripted responses consumed in order; falls back to echo. */
  script?: MockTurn[];
  /** Latency per streamed chunk, ms (0 for tests). */
  chunkDelayMs?: number;
}

export class MockProvider implements ModelProviderAdapter {
  readonly id: string;
  readonly label: string;
  private modelName: string;
  private capabilities: ModelInfo['capabilities'];
  private contextLength: number;
  private script: MockTurn[];
  private chunkDelayMs: number;
  /** Every request received — assertions in tests. */
  readonly requests: GenerationRequest[] = [];
  healthState: ProviderHealth['state'] = 'OK';

  constructor(opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.label = opts.label ?? 'Demo model (built-in)';
    this.modelName = opts.modelName ?? 'demo-local-1';
    this.capabilities = opts.capabilities ?? ALL_MODEL_CAPABILITIES;
    this.contextLength = opts.contextLength ?? 8192;
    this.script = [...(opts.script ?? [])];
    this.chunkDelayMs = opts.chunkDelayMs ?? 0;
  }

  pushScript(turn: MockTurn): void {
    this.script.push(turn);
  }

  async discoverModels(): Promise<ModelInfo[]> {
    return [
      {
        id: `${this.id}:${this.modelName}`,
        providerId: this.id,
        name: this.modelName,
        family: 'mock',
        contextLength: this.contextLength,
        capabilities: [...this.capabilities],
      },
    ];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      state: this.healthState,
      message: this.healthState === 'OK' ? 'Mock provider ready' : 'Mock provider marked unhealthy',
      modelCount: 1,
      checkedAt: nowIso(),
    };
  }

  private nextResult(req: GenerationRequest): GenerationResult {
    this.requests.push(req);
    const turn = this.script.shift();
    if (turn === undefined) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text =
        typeof lastUser?.content === 'string'
          ? `[demo] I received: "${lastUser.content.slice(0, 200)}". Configure a local runtime model in Settings for real answers.`
          : '[demo] image/attachment received (echo mode).';
      return { text, toolCalls: [], finishReason: 'stop' };
    }
    if (typeof turn === 'string') return { text: turn, toolCalls: [], finishReason: 'stop' };
    if (turn.error) return { text: turn.error, toolCalls: [], finishReason: 'error', error: turn.error };
    return {
      text: turn.text ?? '',
      toolCalls: turn.toolCalls ?? [],
      finishReason: turn.toolCalls && turn.toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  chat: ChatModelContract = {
    generate: async (req: GenerationRequest): Promise<GenerationResult> => this.nextResult(req),

    stream: async function* (this: MockProvider, req: GenerationRequest): AsyncIterable<GenerationChunk> {
      const turn = this.script[0];
      const result = this.nextResult(req);
      const pieces =
        turn !== undefined && typeof turn !== 'string' && turn.chunks && turn.chunks.length > 0
          ? turn.chunks
          : result.text
            ? splitChunks(result.text)
            : [];
      for (const p of pieces) {
        if (req.signal?.aborted) {
          yield { textDelta: '' };
          return;
        }
        if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs);
        yield { textDelta: p };
      }
    }.bind(this),
  };

  async embed(): Promise<number[][]> {
    // Deterministic toy embedding for tests (NOT a real semantic model).
    return [];
  }
}

function splitChunks(text: string): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 3) out.push(`${words.slice(i, i + 3).join(' ')}${i + 3 < words.length ? ' ' : ''}`);
  return out.length > 0 ? out : [text];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
