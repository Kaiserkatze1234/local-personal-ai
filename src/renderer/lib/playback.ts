/**
 * Voice playback policy — spec §24. The `voice.speed` / `voice.volume`
 * settings must have an audible effect no matter which backend is bound:
 * volume is always a client-side playback gain (no TTS server consumes it),
 * while speed is only applied here when the backend did NOT synthesize with
 * it — `voice.speak` reports that via `speedApplied` so 1.5x never becomes
 * 2.25x through double application.
 */
export interface VoicePlaybackInput {
  speed: number;
  volume: number;
}

export function resolveSpeechPlayback(
  voice: VoicePlaybackInput,
  resp: { speedApplied?: boolean },
): { volume: number; playbackRate: number } {
  const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1);
  return {
    volume: clamp(voice.volume, 0, 1),
    playbackRate: resp.speedApplied === true ? 1 : clamp(voice.speed, 0.25, 4),
  };
}
