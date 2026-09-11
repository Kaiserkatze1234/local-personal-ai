/**
 * §24 voice settings actually take effect: playback policy is a pure function
 * (volume client-side, speed only when the backend did not apply it), and the
 * voice.speak API reports which case applies — with real flags from the real
 * adapters (Piper-style server = speed consumed; mock = speed not consumed).
 */
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { MockProvider } from '../src/main/providers/adapters/mock.js';
import { PiperHttpAdapter } from '../src/main/providers/adapters/voiceServers.js';
import { resolveSpeechPlayback } from '../src/renderer/lib/playback.js';
import { makeTestApp } from './helpers.js';

describe('voice playback policy (§24)', () => {
  it('volume always applies client-side; speed only when the backend did not consume it', () => {
    expect(resolveSpeechPlayback({ speed: 1.5, volume: 0.4 }, { speedApplied: false })).toEqual({ volume: 0.4, playbackRate: 1.5 });
    expect(resolveSpeechPlayback({ speed: 1.5, volume: 0.4 }, { speedApplied: true })).toEqual({ volume: 0.4, playbackRate: 1 });
  });

  it('out-of-range or garbage settings degrade to safe playback', () => {
    expect(resolveSpeechPlayback({ speed: 99, volume: -3 }, { speedApplied: false })).toEqual({ volume: 0, playbackRate: 4 });
    expect(resolveSpeechPlayback({ speed: Number.NaN, volume: Number.POSITIVE_INFINITY }, { speedApplied: false })).toEqual({
      volume: 1,
      playbackRate: 1,
    });
    expect(resolveSpeechPlayback({ speed: 0, volume: 1 }, { speedApplied: false })).toEqual({ volume: 1, playbackRate: 0.25 }); // clamped to the floor, never muted-by-rate
  });

  it('adapters declare the flag honestly', () => {
    // Piper-style: speed goes into the synthesis request itself, so playback must not re-apply it.
    expect(new PiperHttpAdapter('http://127.0.0.1:50002').tts.appliesSpeed).toBe(true);
    // Mock backend just wraps text into a fake wav — speed is NOT consumed.
    expect(new MockProvider().tts.appliesSpeed === true).toBe(false);
  });

  it('voice.speak response carries speedApplied for the bound backend', async () => {
    const t = await makeTestApp();
    const api = new Api(t.app);
    try {
      t.app.config.patch({ voice: { enabled: true, speed: 1.5, volume: 0.5 } });
      const modelId = t.app.providers.allModels().find((m) => m.providerId === 'mock')!.id;
      t.app.roles.set('tts', modelId);
      const r = await api.handleRaw('voice.speak', ['hallo']);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { audioBase64: string; speedApplied: boolean };
        expect(data.audioBase64.length).toBeGreaterThan(0);
        expect(data.speedApplied).toBe(false); // mock -> the renderer must apply playbackRate itself
      }
    } finally {
      await t.cleanup();
    }
  });
});
