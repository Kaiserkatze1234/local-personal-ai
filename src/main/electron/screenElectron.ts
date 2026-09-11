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
    async capture(): Promise<{ mimeType: string; dataBase64: string }> {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }, // downscale for cheap vision (§21)
      });
      const primary = sources[0];
      if (!primary) throw new Error('No capturable screen found');
      return { mimeType: 'image/png', dataBase64: primary.thumbnail.toDataURL().replace(/^data:image\/png;base64,/, '') };
    },
  };
}
