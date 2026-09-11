/**
 * Voice — spec §24. STT and TTS are separate provider contracts; the app
 * never depends on a specific voice model. When no local voice backend is
 * configured/installed the service reports UNAVAILABLE with steps to fix it
 * (push-to-talk capture works in the renderer already; providers plug in via
 * the registry like everything else).
 */
import type { ComponentStatus } from '../../shared/types/diagnostics.js';
import type { SttRequest, SttResult, TtsRequest } from '../../shared/types/models.js';
import type { ConfigService } from '../core/config.js';
import type { ModelRoleService } from '../providers/modelRegistry.js';
import type { ProviderRegistry } from '../providers/registry.js';

/** A provider registry entry can expose stt/tts adapters; this resolves them. */
export class VoiceService {
  constructor(
    private providers: ProviderRegistry,
    private roles: ModelRoleService,
    private config: ConfigService,
  ) {}

  private sttAdapter(): { transcribe: (req: SttRequest, signal?: AbortSignal) => Promise<SttResult>; providerId: string } | null {
    const binding = this.roles.get('stt');
    if (!binding) return null;
    const found = this.providers.findModel(binding.modelId);
    const stt = found?.provider.adapter.stt;
    if (!stt) return null;
    return { transcribe: (r, s) => stt.transcribe(r, s), providerId: found.provider.id };
  }

  private ttsAdapter(): { synthesize: (req: TtsRequest, signal?: AbortSignal) => AsyncIterable<Uint8Array>; providerId: string } | null {
    const binding = this.roles.get('tts');
    if (!binding) return null;
    const found = this.providers.findModel(binding.modelId);
    const tts = found?.provider.adapter.tts;
    if (!tts) return null;
    return { synthesize: (r, s) => tts.synthesize(r, s), providerId: found.provider.id };
  }

  async transcribe(audio: SttRequest, signal?: AbortSignal): Promise<SttResult | { unavailable: string }> {
    if (!this.config.get().voice.enabled) return { unavailable: 'Voice input is disabled in Settings.' };
    const a = this.sttAdapter();
    if (!a) {
      return {
        unavailable:
          'No local speech-to-text backend is configured. Register one in Settings → Voice (e.g. a whisper.cpp HTTP server or a provider adapter exposing STT).',
      };
    }
    return a.transcribe(audio, signal);
  }

  synthesize(text: string, voice?: string): AsyncIterable<Uint8Array> | { unavailable: string } {
    if (!this.config.get().voice.enabled) return { unavailable: 'Voice output is disabled in Settings.' };
    const a = this.ttsAdapter();
    if (!a) {
      return { unavailable: 'No local text-to-speech backend is configured. Add one in Settings → Voice.' };
    }
    const cfg = this.config.get().voice;
    return a.synthesize({ text, voice: voice ?? undefined, speed: cfg.speed, volume: cfg.volume });
  }

  status(): ComponentStatus {
    const at = new Date().toISOString();
    const enabled = this.config.get().voice.enabled;
    const stt = this.sttAdapter();
    const tts = this.ttsAdapter();
    if (!enabled)
      return {
        id: 'voice',
        label: 'Voice',
        state: 'UNAVAILABLE',
        message: 'Disabled in settings',
        hints: ['Enable under Settings → Voice'],
        updatedAt: at,
      };
    if (!stt && !tts) {
      return {
        id: 'voice',
        label: 'Voice',
        state: 'UNAVAILABLE',
        message: 'No STT/TTS provider registered',
        hints: ['Start a local whisper.cpp server or install a provider exposing audio adapters'],
        updatedAt: at,
      };
    }
    const parts = [`STT ${stt ? 'ready' : 'missing'}`, `TTS ${tts ? 'ready' : 'missing'}`];
    return {
      id: 'voice',
      label: 'Voice',
      state: stt && tts ? 'OK' : 'WARNING',
      message: parts.join(', '),
      hints: stt && tts ? [] : ['Bind the missing role in Settings → Voice'],
      updatedAt: at,
    };
  }
}
