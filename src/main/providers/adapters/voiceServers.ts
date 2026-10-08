/**
 * Voice backend adapters — spec §24 ("possible local backends can be added
 * through adapters"). Two cheap, common local servers are supported out of
 * the box; both are optional and auto-registered only when the user
 * configures their URLs (Settings → Voice). The app never depends on these:
 * STT/TTS are plain provider contracts, any other backend can replace them.
 */
import { nowIso } from '../../../shared/types/common.js';
import type {
  ModelInfo,
  ModelProviderAdapter,
  ProviderHealth,
  SttModelContract,
  SttRequest,
  TtsModelContract,
  TtsRequest,
} from '../../../shared/types/models.js';
import { unhealth } from '../registry.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function model(providerId: string, name: string, caps: ModelInfo['capabilities'], sizeBytes?: number): ModelInfo {
  return { id: `${providerId}:${name}`, providerId, name, contextLength: 0, capabilities: caps, sizeBytes };
}

async function ping(baseUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/`, { method: 'GET', signal: AbortSignal.timeout(4000) });
    return r.status < 500; // a listening server counts as reachable even on 404
  } catch {
    return false;
  }
}

/** whisper.cpp's built-in HTTP server (`whisper-server -host 127.0.0.1 -port 8080`). */
export class WhisperHttpAdapter implements ModelProviderAdapter {
  readonly id = 'whisper';
  readonly label = 'whisper.cpp (local HTTP)';
  constructor(
    private baseUrl = 'http://127.0.0.1:8080',
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    const ok = await ping(this.baseUrl, this.fetchImpl);
    return ok
      ? { providerId: this.id, state: 'OK', message: `whisper server reachable at ${this.baseUrl}`, checkedAt: nowIso() }
      : unhealth(
          this.id,
          `No whisper.cpp server answering at ${this.baseUrl}. Start e.g. "whisper-server --model ggml-large-v3.bin --port 8080".`,
        );
  }

  async discoverModels(): Promise<ModelInfo[]> {
    return [model(this.id, 'whisper-cpp', ['audio_input'])];
  }

  stt: SttModelContract = {
    transcribe: async (req: SttRequest, signal?: AbortSignal): Promise<{ text: string }> => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mimeType || 'audio/wav' }), 'audio');
      form.append('temperature', '0');
      if (req.language) form.append('language', req.language); // 'de' by default via config (§24 German-first usage)
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/inference`, { method: 'POST', body: form, signal });
      if (!res.ok) throw new Error(`whisper server returned HTTP ${res.status}`);
      const json = (await res.json()) as { text?: string };
      return { text: (json.text ?? '').trim() };
    },
  };
}

/**
 * Local TTS behind an OpenAI-compatible /v1/audio/speech endpoint — the
 * contract most local piper/bridges speak. JSON in, audio bytes out; speed
 * and voice pass through (§24: adjustable speed, voice selection).
 */
export class PiperHttpAdapter implements ModelProviderAdapter {
  readonly id = 'localtts';
  readonly label = 'Local TTS (OpenAI-compatible /v1/audio/speech)';
  constructor(
    private baseUrl = 'http://127.0.0.1:5000',
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    const ok = await ping(this.baseUrl, this.fetchImpl);
    return ok
      ? { providerId: this.id, state: 'OK', message: `TTS server reachable at ${this.baseUrl}`, checkedAt: nowIso() }
      : unhealth(
          this.id,
          `No TTS server answering at ${this.baseUrl}. Any local OpenAI-compatible /v1/audio/speech service (e.g. a piper bridge) works.`,
        );
  }

  async discoverModels(): Promise<ModelInfo[]> {
    return [model(this.id, 'local-tts', ['audio_output'])];
  }

  tts: TtsModelContract = {
    // The request body carries `speed`, so playback must not re-apply it (§24).
    appliesSpeed: true,
    synthesize: (req, signal) => this.synthesizeStream(req, signal),
  };

  private async *synthesizeStream(req: TtsRequest, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: req.text, ...(req.voice ? { voice: req.voice } : {}), ...(req.speed ? { speed: req.speed } : {}) }),
      signal,
    });
    if (!res.ok) throw new Error(`TTS server returned HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // yield slices so consumers can start playback of long answers progressively
    for (let i = 0; i < buf.length; i += 65536) yield buf.subarray(i, i + 65536);
  }
}
