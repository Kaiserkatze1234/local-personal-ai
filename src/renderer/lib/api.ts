/**
 * Renderer-side API client. In Electron it goes through the preload bridge;
 * in a plain browser (vite dev without electron) it degrades to a clear
 * "not connected" state instead of crashing (preview-friendly dev).
 */
import type { InvokeContract, InvokeResult } from '../../shared/types/ipc.js';

type Method = keyof InvokeContract & string;
type ArgsOf<M extends Method> = InvokeContract[M]['args'];
type ResOf<M extends Method> = InvokeContract[M]['res'];

interface Bridge {
  invoke(method: string, ...args: unknown[]): Promise<InvokeResult<unknown>>;
  onEvent(cb: (e: unknown) => void): () => void;
  onOverlayText?(cb: (t: string) => void): () => void;
  onPtt?(cb: (a: 'toggle') => void): () => void;
}

declare global {
  interface Window {
    lpai?: Bridge;
  }
}

export class ApiError extends Error {
  kind: string;
  recovery?: string[];
  constructor(kind: string, message: string, recovery?: string[]) {
    super(message);
    this.kind = kind;
    this.recovery = recovery;
  }
}

const bridge: Bridge | null = typeof window !== 'undefined' && window.lpai ? window.lpai : null;

export const hasBridge = bridge !== null;

export async function call<M extends Method>(method: M, ...args: ArgsOf<M>): Promise<ResOf<M>> {
  if (!bridge) throw new ApiError('not_connected', 'Renderer is not connected to the app core (run inside Electron).');
  const res = await bridge.invoke(method, ...args);
  if (res.ok) return res.data as ResOf<M>;
  throw new ApiError(res.error.kind, res.error.message, res.error.recovery);
}

export function onEvent(cb: (e: import('../../shared/types/events.js').AppEvent) => void): () => void {
  if (!bridge) return () => undefined;
  return bridge.onEvent((e) => cb(e as import('../../shared/types/events.js').AppEvent));
}

export function onOverlayText(cb: (t: string) => void): () => void {
  if (!bridge?.onOverlayText) return () => undefined;
  return bridge.onOverlayText(cb);
}

export function onPtt(cb: (a: 'toggle') => void): () => void {
  if (!bridge?.onPtt) return () => undefined;
  return bridge.onPtt(cb);
}
