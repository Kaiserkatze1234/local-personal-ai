/**
 * Vision — spec §21/§25. Capability-routed: screenshot analysis only runs
 * when a bound model actually declares `vision`; otherwise the user gets an
 * honest explanation (§3.8). Captures are ephemeral by default (§21).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../shared/types/common.js';
import type { ComponentStatus } from '../../shared/types/diagnostics.js';
import type { ChatMessage } from '../../shared/types/models.js';
import type { ConfigService } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelRouter } from '../providers/router.js';

/** Pluggable screen source (Electron desktopCapturer in the real app). */
export interface ScreenSource {
  available(): boolean;
  capture(): Promise<{ mimeType: string; dataBase64: string }>;
}

export class VisionService {
  private lastCapture: { mimeType: string; dataBase64: string; at: number } | null = null;

  constructor(
    private router: ModelRouter,
    private providers: ProviderRegistry,
    private config: ConfigService,
    private dataDir: string,
    private log: SubLogger,
    private screen?: ScreenSource,
  ) {}

  status(): ComponentStatus {
    const at = new Date().toISOString();
    const visionModel = this.providers.allModels().find((m) => m.capabilities.includes('vision'));
    if (!this.config.get().vision.enabled) {
      return {
        id: 'vision',
        label: 'Vision',
        state: 'UNAVAILABLE',
        message: 'Disabled in settings',
        hints: ['Enable under Settings → Vision'],
        updatedAt: at,
      };
    }
    if (!visionModel) {
      return {
        id: 'vision',
        label: 'Vision',
        state: 'UNAVAILABLE',
        message: 'No installed runtime model advertises vision capability',
        hints: ['Install a vision-capable model (e.g. qwen2.5-VL / llava family) and bind it to the Vision role'],
        updatedAt: at,
      };
    }
    return { id: 'vision', label: 'Vision', state: 'OK', message: `Vision available via ${visionModel.name}`, hints: [], updatedAt: at };
  }

  screenAvailable(): boolean {
    return this.screen?.available() ?? false;
  }

  /** Captures the screen and keeps it in memory only unless persist configured. */
  async captureScreen(): Promise<{ mimeType: string; dataBase64: string }> {
    if (!this.screen?.available()) {
      throw new AppError('not_implemented', 'Screen capture is not available in this session (needs the Electron desktop shell).', [
        'Use the app window, or attach an image file directly',
      ]);
    }
    const shot = await this.screen.capture();
    this.lastCapture = { ...shot, at: Date.now() };
    if (this.config.get().vision.persistScreenshots) {
      const dir = join(this.dataDir, 'screens');
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${newId('shot')}.png`);
      writeFileSync(p, Buffer.from(shot.dataBase64, 'base64'));
      this.log.debug(`screenshot persisted at ${p} (user config allows persistence)`);
    }
    return shot;
  }

  async analyzeScreen(question: string): Promise<{ text: string; modelId: string } | { unavailable: string }> {
    const shot =
      this.lastCapture && Date.now() - this.lastCapture.at < 60_000
        ? this.lastCapture
        : await this.captureScreen()
            .then((s) => ({ ...s, at: Date.now() }))
            .catch(() => null);
    if (!shot) return { unavailable: 'Could not capture the screen on this system.' };
    const r = await this.analyzeImages(question, [{ mimeType: shot.mimeType, dataBase64: shot.dataBase64 }]);
    return 'text' in r ? r : r;
  }

  async analyzeImages(
    question: string,
    images: { mimeType: string; dataBase64: string }[],
  ): Promise<{ text: string; modelId: string } | { unavailable: string }> {
    let decision: import('../providers/router.js').RouteDecision;
    try {
      decision = this.router.select('vision', 'vision', { needsVision: true });
    } catch (err) {
      return { unavailable: err instanceof AppError ? err.message : 'Vision capability unavailable.' };
    }
    const { provider } = this.providers.chatFor(decision.modelId);
    if (!provider.adapter.chat) return { unavailable: 'Provider has no chat interface.' };
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: question || 'Describe what is on screen and point out anything that looks like a problem.' },
        ...images.map((i) => ({ type: 'image' as const, mimeType: i.mimeType, dataBase64: i.dataBase64 })),
      ],
    };
    const res = await provider.adapter.chat.generate({ modelId: decision.modelId, messages: [msg], temperature: 0.3 });
    return { text: res.text, modelId: decision.modelId };
  }

  /** Short textual description of the last capture, for the context engine. */
  async describeLastScreenForContext(): Promise<string | null> {
    if (!this.lastCapture || Date.now() - this.lastCapture.at > 120_000) return null;
    const r = await this.analyzeScreen('Briefly (3 bullets max): what is on this screen right now?');
    if ('text' in r) return r.text;
    return null;
  }

  clear(): void {
    this.lastCapture = null;
  }
}

/** Placeholder persistence helper used by tests to keep imports honest. */
export function visionDirExists(dataDir: string): boolean {
  return existsSync(join(dataDir, 'screens'));
}
