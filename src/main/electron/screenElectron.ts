/**
 * Electron-backed screen source (Phase 9/§21). desktopCapturer works on
 * Windows; region capture + GUI automation are intentionally NOT faked —
 * they would need native helpers (documented in docs/PHASE_MAP.md).
 */
import { desktopCapturer, screen as electronScreen } from 'electron';
import type { ScreenSource } from '../vision/visionService.js';

export function createElectronScreenSource(): ScreenSource {
  return {
    available(): boolean {
      try {
        return electronScreen.getAllDisplays().length > 0;
      } catch {
        return false;
      }
    },
    async capture(opts?: {
      rect?: { x: number; y: number; width: number; height: number };
    }): Promise<{ mimeType: string; dataBase64: string }> {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }, // downscale for cheap vision (§21)
      });
      const primary = sources[0];
      if (!primary) throw new Error('No capturable screen found');
      let image = primary.thumbnail;
      // NOTE: rect is in downscaled-thumbnail space (1920-wide) — good enough for analysis crops
      if (opts?.rect && image.getSize().width > 0) {
        const r = opts.rect;
        const cropped = image.crop({
          x: Math.max(0, r.x),
          y: Math.max(0, r.y),
          width: Math.max(8, r.width),
          height: Math.max(8, r.height),
        });
        if (!cropped.isEmpty()) image = cropped;
      }
      return { mimeType: 'image/png', dataBase64: image.toDataURL().replace(/^data:image\/png;base64,/, '') };
    },
  };
}
