/** Error taxonomy — spec §39. One error class for the whole app. */
import type { ErrorKind } from '../../shared/types/tools.js';

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly recovery: string[];

  constructor(kind: ErrorKind, message: string, recovery: string[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.kind = kind;
    this.recovery = recovery;
  }

  toJSON() {
    return { kind: this.kind, message: this.message, recovery: this.recovery };
  }

  static notImplemented(feature: string, phase: number): AppError {
    return new AppError('not_implemented', `Feature "${feature}" is planned for Phase ${phase} and not built yet.`, [
      `Read docs/PHASE_MAP.md for the status of every phase`,
    ]);
  }

  static provider(reason: string): AppError {
    return new AppError('provider', reason, ['Check the provider health screen', 'Try another provider in Settings']);
  }

  static permission(reason: string): AppError {
    return new AppError('permission_denied', reason, ['Grant the permission in the dialog or raise the permission mode']);
  }

  static invalidState(reason: string): AppError {
    return new AppError('invalid_state', reason);
  }
}

export function toErrorInfo(err: unknown): { kind: string; message: string; recovery?: string[] } {
  if (err instanceof AppError) return { kind: err.kind, message: err.message, recovery: err.recovery };
  if (err instanceof Error) return { kind: 'tool', message: err.message };
  return { kind: 'tool', message: String(err) };
}
