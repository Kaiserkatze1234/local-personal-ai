/**
 * Command execution — spec §36. Preview, cwd, timeout, cancellation, output
 * capture with caps, exit code, and a danger scan that forces confirmation.
 * Windows: commands run through cmd.exe; POSIX through /bin/sh -c.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ToolResult } from '../../shared/types/tools.js';
import { truncateMiddle } from '../../shared/util/text.js';
import type { ToolRegistry } from './registry.js';

const OUTPUT_CAP = 64 * 1024;

/** Patterns that are always escalated to explicit confirmation (or denied). */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\\|~|\$home|\*|\/\*)/i,
  /\bdel\s+\/s\s+\/q\s+c:[\\ ]/i,
  /\brd\s+\/s\s+\/q\s+c:[\\ ]/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bshutdown\b/i,
  /\bdel\b.*[a-z]:\\(?:\s|$|\*)/i,
  /\bmklink\b/i,
  /\bnano\s+\/dev\/sd/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\biwr\b.*\|\s*iex/i, // Invoke-Expression pipe
  /\bSet-MpPreference\b.*DisableRealtimeMonitoring/i,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

export function registerCommandTools(
  registry: ToolRegistry,
  deps: { commandTimeoutSec: () => number; onCommandFinished?: (info: { command: string; exitCode: number | null; cwd: string }) => void },
): void {
  registry.register(
    {
      name: 'run_command',
      description:
        'Run a shell command in a working directory. Returns exit code + captured output. Destructive commands require user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1 },
          cwd: { type: 'string' },
          timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 },
        },
        required: ['command'],
      },
      permission: 'commands.execute',
      mutating: true,
      phase: 4,
    },
    async (input, ctx): Promise<ToolResult> => {
      const command = String(input.command ?? '').trim();
      if (!command) return { ok: false, summary: 'Empty command', error: { kind: 'user', message: 'command required' } };
      const cwd = input.cwd ? resolve(String(input.cwd)) : (ctx.cwd() ?? process.cwd());
      const timeoutSec = Number(input.timeoutSec ?? deps.commandTimeoutSec());
      // NOTE: danger escalation (force confirmation) happens in the ToolRegistry
      // via the assessRisk hook before the permission check — see registry.call().
      const t0 = Date.now();
      const isWin = process.platform === 'win32';
      const child = spawn(command, {
        cwd,
        shell: isWin ? 'cmd.exe' : '/bin/sh',
        windowsHide: true,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let overflow = false;
      const append = (buf: Buffer, which: 'stdout' | 'stderr'): void => {
        const text = buf.toString('utf8');
        if (which === 'stdout') stdout += text;
        else stderr += text;
        if (stdout.length + stderr.length > OUTPUT_CAP) overflow = true;
      };
      child.stdout?.on('data', (b: Buffer) => append(b, 'stdout'));
      child.stderr?.on('data', (b: Buffer) => append(b, 'stderr'));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, Math.max(1, timeoutSec) * 1000);
      timer.unref?.();

      const abort = (): void => {
        killTree(child);
      };
      ctx.signal?.addEventListener('abort', abort, { once: true });

      const exitCode = await new Promise<number | null>((res) => {
        child.on('close', (code) => res(code));
        child.on('error', () => res(null));
      }).finally(() => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', abort);
      });

      const cancelled = ctx.signal?.aborted === true && !timedOut;
      deps.onCommandFinished?.({ command, exitCode, cwd });

      if (timedOut) {
        return {
          ok: false,
          summary: `Command timed out after ${timeoutSec}s and was terminated.`,
          error: {
            kind: 'timeout',
            message: `timeout ${timeoutSec}s`,
            recovery: ['Raise timeoutSec', 'Split the work into smaller commands'],
          },
          stdoutPreview: truncateMiddle(stdout, 4000),
          stderrPreview: truncateMiddle(stderr, 2000),
        };
      }
      if (cancelled) {
        return { ok: false, summary: 'Command cancelled by user.', error: { kind: 'invalid_state', message: 'cancelled' } };
      }

      const ok = exitCode === 0;
      return {
        ok,
        summary: `Exited ${exitCode} after ${((Date.now() - t0) / 1000).toFixed(1)}s in ${cwd}${overflow ? ' (output truncated)' : ''}`,
        exitCode: exitCode ?? undefined,
        stdoutPreview: truncateMiddle(stdout, 6000),
        stderrPreview: truncateMiddle(stderr, 3000),
        data: {
          exitCode,
          cwd,
          // Structured excerpt for the model — not raw unlimited dump (§10).
          stdout: truncateMiddle(stdout, 12000),
          stderr: truncateMiddle(stderr, 6000),
        },
      };
    },
  );
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () =>
        child.kill('SIGKILL'),
      );
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* process already gone */
  }
}
