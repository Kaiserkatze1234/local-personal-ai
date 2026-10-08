/**
 * Window placement persistence — reopen the main window where the user left
 * it, which is baseline behavior for a usable Windows desktop app. Pure
 * (JSON in, placement out) so the risky part — a saved position on a monitor
 * that no longer exists, the #1 "app opens off-screen" Windows bug — is
 * unit-testable without Electron. index.ts does the file IO + wiring.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const MIN_W = 200;
const MIN_H = 160;

const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * Validate a parsed placement against the current screens.
 * `displays` are work areas (taskbar excluded). A position is kept only if
 * the window's top-left corner would be visible on some display — otherwise
 * it is dropped and the window opens centered at the saved size.
 */
export function parsePlacement(raw: unknown, displays: Rect[], fallback: { width: number; height: number }): Placement {
  if (typeof raw !== 'object' || raw === null) return { ...fallback, maximized: false };
  const r = raw as Record<string, unknown>;
  const width = int(r.width);
  const height = int(r.height);
  const x = int(r.x);
  const y = int(r.y);
  const out: Placement = {
    width: width !== undefined && width >= MIN_W ? width : fallback.width,
    height: height !== undefined && height >= MIN_H ? height : fallback.height,
    maximized: r.maximized === true,
  };
  if (x !== undefined && y !== undefined && displays.length > 0) {
    const cornerVisible = displays.some((d) => x >= d.x - 8 && x <= d.x + d.width - 80 && y >= d.y - 8 && y <= d.y + d.height - 40);
    if (cornerVisible) {
      out.x = x;
      out.y = y;
    }
  }
  return out;
}

/** Current geometry -> serializable record. */
export function snapshotPlacement(b: Rect & { maximized: boolean }): Placement {
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: b.maximized };
}
