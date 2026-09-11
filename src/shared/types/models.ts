/**
 * Provider/model contracts (spec §6). The finished application only ever
 * talks to these interfaces — never to a concrete model or to Ollama
 * directly. Qwen Coder 8B is a development model and appears nowhere here.
 */
import type { HealthState, ModelCapability } from './capabilities.js';

export interface ModelInfo {
  /** Global unique id: `${providerId}:${modelName}` */
  id: string;
  providerId: string;
  name: string;
  family?: string;
  parameterCountB?: number;
  quantization?: string;
  contextLength: number;
  capabilities: ModelCapability[];
  sizeBytes?: number;
  /** True when the runtime reports the model resident in VRAM/RAM. */
  loaded?: boolean;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentPartText {
  type: 'text';
  text: string;
}
export interface ContentPartImage {
  type: 'image';
  mimeType: string;
  dataBase64: string;
  /** Optional local file reference for transparency/rollback (not sent to model). */
  sourcePath?: string;
}
export type ContentPart = ContentPartText | ContentPartImage;

export interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  id?: string;
  role: ChatRole;
  content: string | ContentPart[];
  /** assistant -> requested calls */
  toolCalls?: ToolCallSpec[];
  /** role === 'tool' */
  toolCallId?: string;
  name?: string;
  createdAt?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  parameters: Record<string, unknown>;
}

export interface GenerationRequest {
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  /** structured_output: request JSON objects from the model if capable. */
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** Ollama-style: keep model loaded this many seconds (0 = unload after). */
  keepAliveSec?: number;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerationResult {
  text: string;
  toolCalls: ToolCallSpec[];
  usage?: GenerationUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error';
  error?: string;
}

export interface GenerationChunk {
  textDelta: string;
}

export interface ProviderHealth {
  providerId: string;
  state: HealthState;
  message?: string;
  latencyMs?: number;
  modelCount?: number;
  checkedAt: string;
}

export interface ChatModelContract {
  generate(req: GenerationRequest): Promise<GenerationResult>;
  stream(req: GenerationRequest): AsyncIterable<GenerationChunk>;
}

export interface EmbeddingModelContract {
  embed(modelId: string, texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface SttRequest {
  audio: Uint8Array;
  mimeType: string;
  language?: string;
}
export interface SttResult {
  text: string;
  confidence?: number;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  volume?: number;
}

export interface SttModelContract {
  transcribe(req: SttRequest, signal?: AbortSignal): Promise<SttResult>;
}
export interface TtsModelContract {
  /** Yields audio bytes (wav chunks). Provider decides container. */
  synthesize(req: TtsRequest, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  /**
   * True when the backend applies `req.speed` during synthesis itself (e.g. a
   * Piper-style server's `speed` parameter). The player must then NOT also
   * change playback rate — otherwise a 1.5x setting would become 2.25x.
   * Absent/false means the configured speed is only honored client-side (§24).
   */
  appliesSpeed?: boolean;
}

/**
 * One provider adapter = one local runtime family (Ollama, OpenAI-compatible
 * server, mock/demo…). Adapters are optional per capability; the registry
 * must tolerate missing ones (§6 "gracefully handle providers that lack some").
 */
export interface ModelProviderAdapter {
  readonly id: string;
  readonly label: string;
  discoverModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<ProviderHealth>;
  chat?: ChatModelContract;
  embeddings?: EmbeddingModelContract;
  stt?: SttModelContract;
  tts?: TtsModelContract;
  /** Ask the runtime to unload a model to free VRAM (§56). Optional. */
  unloadModel?(modelId: string): Promise<boolean>;
}

export interface RoleAssignment {
  role: string;
  modelId: string;
  providerId: string;
  updatedAt: string;
}
