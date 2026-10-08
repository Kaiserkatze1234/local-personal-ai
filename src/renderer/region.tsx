/**
 * Region selection surface (§21): drag a rectangle over the screen; the rect
 * (physical pixels) is submitted through 'region.submit', Escape cancels.
 */
import { type ReactElement, useCallback, useRef, useState } from 'react';
import { call } from './lib/api.js';

interface P {
  x: number;
  y: number;
}

function RegionSelect(): ReactElement {
  const [start, setStart] = useState<P | null>(null);
  const [cur, setCur] = useState<P | null>(null);
  const dpr = useRef(window.devicePixelRatio || 1);

  const finish = useCallback((a: P, b: P): void => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x);
    const height = Math.abs(a.y - b.y);
    if (width < 12 || height < 12) {
      void call('region.submit', null); // too small => treat as cancel
      return;
    }
    void call('region.submit', {
      x: Math.round(x * dpr.current),
      y: Math.round(y * dpr.current),
      width: Math.round(width * dpr.current),
      height: Math.round(height * dpr.current),
    });
  }, []);

  const rect =
    start && cur
      ? {
          left: Math.min(start.x, cur.x),
          top: Math.min(start.y, cur.y),
          width: Math.abs(cur.x - start.x),
          height: Math.abs(cur.y - start.y),
        }
      : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(10, 14, 24, 0.35)', cursor: 'crosshair', userSelect: 'none' }}
      onMouseDown={(e) => {
        setStart({ x: e.clientX, y: e.clientY });
        setCur({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e) => {
        if (start) setCur({ x: e.clientX, y: e.clientY });
      }}
      onMouseUp={(e) => {
        if (start) finish(start, { x: e.clientX, y: e.clientY });
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          color: '#dfe6ff',
          font: '13px system-ui',
          background: 'rgba(15,20,34,.9)',
          padding: '6px 14px',
          borderRadius: 8,
        }}
      >
        Aufziehen zum Wählen · Esc abbrechen
      </div>
      {rect && (
        <div
          style={{
            position: 'absolute',
            ...rect,
            border: '1.5px solid #7aa2ff',
            background: 'rgba(122,162,255,0.14)',
            boxShadow: '0 0 0 9999px rgba(6,9,16,0.35)',
          }}
        />
      )}
      {rect && rect.width > 90 && (
        <div style={{ position: 'absolute', left: rect.left, top: rect.top - 22, color: '#9fb8ff', font: '11px ui-monospace, monospace' }}>
          {Math.round(rect.width)}×{Math.round(rect.height)}
        </div>
      )}
    </div>
  );
}

// createRoot import below (kept separate so the file stays lint-order-stable)
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root') as HTMLElement).render(<RegionSelect />);
