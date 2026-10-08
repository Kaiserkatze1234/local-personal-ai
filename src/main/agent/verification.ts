/**
 * Verification engine — spec §38. Every meaningful autonomous action maps to
 * an honest verification strategy; "no verification possible" is an explicit,
 * visible outcome rather than a silent success (§8: never claim success
 * without verification when verification is possible).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { nowIso } from '../../shared/types/common.js';
import type { VerificationResult } from '../../shared/types/task.js';
import type { SubLogger } from '../core/logger.js';

export type VerificationPlan =
  | { kind: 'file_written'; path: string; expectContains?: string }
  | { kind: 'config_valid'; path: string; format: 'json' }
  | { kind: 'code_change'; cwd: string; commands: string[] } // tests/build chosen by caller
  | { kind: 'command_result'; expectExit: number; exitCode: number | undefined }
  | { kind: 'none'; reason: string };

async function runShell(cwd: string, command: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    let out = '';
    let done = false;
    const child = spawn(command, { cwd, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', windowsHide: true });
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(0, 32_000);
    });
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(0, 32_000);
    });
    const timer = setTimeout(() => {
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      res({ code: -1, out: `${out}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` });
    }, timeoutMs);
    timer.unref?.();
    child.on('close', (code) => {
      if (done) return;
      clearTimeout(timer);
      res({ code, out });
    });
    child.on('error', (e) => {
      if (done) return;
      clearTimeout(timer);
      res({ code: -2, out: e.message });
    });
  });
}

export class VerificationEngine {
  constructor(private log: SubLogger) {}

  async verify(plan: VerificationPlan, taskId?: string): Promise<VerificationResult> {
    const base = { at: nowIso() };
    switch (plan.kind) {
      case 'file_written': {
        const ok = existsSync(plan.path);
        let contentOk = true;
        if (ok && plan.expectContains) {
          try {
            contentOk = readFileSync(plan.path, 'utf8').includes(plan.expectContains);
          } catch {
            contentOk = false;
          }
        }
        return {
          ...base,
          attempted: true,
          passed: ok && contentOk,
          method: 'file existence + content check',
          details: ok
            ? contentOk
              ? `File present at ${plan.path}${plan.expectContains ? ', expected content confirmed' : ''}.`
              : 'File present but expected content missing.'
            : `File missing: ${plan.path}`,
        };
      }
      case 'config_valid': {
        try {
          JSON.parse(readFileSync(plan.path, 'utf8'));
          return { ...base, attempted: true, passed: true, method: 'parse config', details: `${plan.path} parses as valid JSON.` };
        } catch (err) {
          return {
            ...base,
            attempted: true,
            passed: false,
            method: 'parse config',
            details: `${plan.path} invalid: ${(err as Error).message}`,
          };
        }
      }
      case 'code_change': {
        const commands = plan.commands.slice(0, 3);
        if (commands.length === 0) {
          return {
            ...base,
            attempted: false,
            passed: false,
            method: 'none available',
            details: 'No test/build command discovered for this project. Verification not possible — treat the change as unverified.',
          };
        }
        const results: string[] = [];
        let passed = true;
        for (const cmd of commands) {
          const r = await runShell(plan.cwd, cmd, 8 * 60_000);
          results.push(`$ ${cmd} → exit ${r.code}`);
          if (r.code !== 0) {
            passed = false;
            results.push(tail(r.out, 1500));
            break; // first failure is enough signal for the summary
          }
        }
        this.log.debug(`verification ${passed ? 'passed' : 'failed'} for ${taskId ?? 'n/a'}`, taskId);
        return { ...base, attempted: true, passed, method: `commands: ${commands.join(' && ')}`, details: results.join('\n') };
      }
      case 'command_result': {
        const passed = plan.exitCode === plan.expectExit;
        return {
          ...base,
          attempted: true,
          passed,
          method: 'exit code',
          details: `expected ${plan.expectExit}, got ${plan.exitCode ?? 'unknown'}`,
        };
      }
      case 'none':
        return { ...base, attempted: false, passed: false, method: 'none available', details: plan.reason };
    }
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}
