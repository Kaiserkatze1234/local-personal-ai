/**
 * Contract test for the E2E suite.
 *
 * The E2E specs only run on a machine that can actually open an Electron
 * window (the Windows runner). Everything they *assume* about the app can be
 * checked without one, and those assumptions are exactly what silently rots
 * when someone renames an IPC method or a CSS class: the E2E suite would fail
 * on the runner — or, worse, pass while asserting nothing.
 *
 * So this suite is the watchdog for the wiring:
 *   - every IPC method the specs call exists in the preload allowlist,
 *   - every CSS selector the specs query exists in the renderer,
 *   - the config the harness writes before launch is schema-shaped (top-level
 *     groups + role names from the real types),
 *   - the model-id convention the harness binds roles to matches the adapters,
 *   - the PowerShell setup scripts stay ASCII (Windows PowerShell 5.1 reads
 *     .ps1 as ANSI; non-ASCII bytes turn into mojibake).
 *
 * It is fast, deterministic and needs nothing but the repository.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/shared/types/config.js';

const ROOT = join(__dirname, '..');
const E2E_DIR = join(ROOT, 'tests', 'e2e');

function readAll(): { name: string; text: string }[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(E2E_DIR, f), 'utf8') }));
}

function rendererSource(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx|ts|css|html)$/.test(entry)) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(join(ROOT, 'src', 'renderer'));
  return out.join('\n');
}

const spec = readAll();
const specText = spec.map((f) => f.text).join('\n');

describe('E2E contract — the specs only depend on things that exist', () => {
  it('every IPC method the specs call is in the preload allowlist', () => {
    const preload = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
    const allowed = new Set([...preload.matchAll(/^\s*'([a-z][\w.]*)',\s*$/gm)].map((m) => m[1]).filter((m): m is string => Boolean(m)));
    expect(allowed.size, 'Allowlist erkannt').toBeGreaterThan(30);

    // the one deliberate exception: the allowlist spec calls a method that MUST
    // be rejected. Everything else has to exist — and the negative case itself
    // is asserted, so the exception cannot quietly swallow a real typo.
    const blockProbe = /invoke\(\s*'(definitely\.[\w.]*)'/g;
    const probes = new Set([...specText.matchAll(blockProbe)].map((m) => m[1]).filter((m): m is string => Boolean(m)));
    expect(probes.size, 'Sonde fuer die Allowlist').toBe(1);
    expect(specText, 'die Sonde muss als blockiert geprueft werden').toContain('Blocked IPC method');

    const called = new Set(
      [...specText.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z][\w.]*)'/g)]
        .map((m) => m[1])
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
        .filter((m) => !probes.has(m)),
    );
    expect(called.size, 'IPC-Aufrufe in den Specs gefunden').toBeGreaterThan(3);
    for (const method of called) {
      expect(allowed.has(method), `IPC-Methode "${method}" fehlt in src/preload/index.ts`).toBe(true);
    }
  });

  it('every CSS selector the specs query exists in the renderer', () => {
    const renderer = rendererSource();
    const selectors = new Set([...specText.matchAll(/locator\(\s*'([^']+)'/g)].map((m) => m[1]).filter((s): s is string => Boolean(s)));
    expect(selectors.size, 'Selektoren gefunden').toBeGreaterThan(4);
    for (const sel of selectors) {
      for (const cls of [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((c): c is string => Boolean(c))) {
        const present =
          renderer.includes(`.${cls}`) || renderer.includes(`"${cls}`) || renderer.includes(` ${cls} `) || renderer.includes(`'${cls}'`);
        expect(present, `CSS-Klasse "${cls}" (Selektor "${sel}") kommt im Renderer nicht vor`).toBe(true);
      }
      // id selectors (#foo) would need an id in the renderer — none are used today
      expect(sel.includes('#'), `ID-Selektor "${sel}" ist unerwünscht (Klassen sind stabiler)`).toBe(false);
    }
  });

  it('the pre-launch config matches the real config schema', () => {
    const harness = spec.find((f) => f.name === 'harness.ts');
    expect(harness, 'harness.ts gefunden').toBeTruthy();
    const block = /export function e2eConfig\([^)]*\)[^{]*{([\s\S]*?)\n}/.exec(harness!.text)?.[1] ?? '';
    expect(block.length, 'e2eConfig gefunden').toBeGreaterThan(100);

    // top-level groups written by the harness
    const groups = [...block.matchAll(/^\s*([a-zA-Z]+):\s*{/gm)].map((m) => m[1]).filter((g): g is string => Boolean(g));
    const known = Object.keys(defaultConfig());
    expect(groups.length).toBeGreaterThan(5);
    for (const g of groups) {
      expect(known, `Konfigurationsgruppe "${g}" existiert nicht in AppConfig`).toContain(g);
    }

    // role names used in ai.routingOverride
    const caps = readFileSync(join(ROOT, 'src', 'shared', 'types', 'capabilities.ts'), 'utf8');
    const roleUnion = /export type ModelRole =([^;]+);/.exec(caps)?.[1] ?? '';
    const roles = [...roleUnion.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(roles.length, 'ModelRole-Union gefunden').toBeGreaterThan(4);
    const override = /const roles = \[([^\]]+)\]/.exec(harness!.text)?.[1] ?? '';
    const used = [...override.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((r): r is string => Boolean(r));
    expect(used.length).toBeGreaterThan(3);
    for (const r of used) expect(roles, `Rolle "${r}" ist kein ModelRole`).toContain(r);
  });

  it('the model ids the harness binds are the ids the adapters produce', () => {
    // harness: `openai_compat:${modelName}` | real spec: `ollama:${model}`
    const ollama = readFileSync(join(ROOT, 'src', 'main', 'providers', 'adapters', 'ollama.ts'), 'utf8');
    const compat = readFileSync(join(ROOT, 'src', 'main', 'providers', 'adapters', 'openaiCompat.ts'), 'utf8');
    const idConvention = /\$\{this\.id\}:\$\{/;
    expect(ollama, 'Ollama-Adapter präfixt Modell-IDs mit der Provider-ID').toMatch(idConvention);
    expect(compat, 'OpenAI-Compat-Adapter präfixt Modell-IDs mit der Provider-ID').toMatch(idConvention);
    // and the router resolves exactly those ids
    const router = readFileSync(join(ROOT, 'src', 'main', 'providers', 'router.ts'), 'utf8');
    expect(router).toContain('routingOverride[role]');
    expect(router).toContain('findModel(override)');
  });

  it('the Windows setup scripts are ASCII (PowerShell 5.1 reads .ps1 as ANSI)', () => {
    const dir = join(ROOT, 'scripts', 'windows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ps1'));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const raw = readFileSync(join(dir, f));
      const offenders = [...new Set([...raw.toString('utf8')].filter((c) => c.charCodeAt(0) > 126))];
      expect(offenders, `${f} enthält Nicht-ASCII: ${offenders.join(' ')}`).toEqual([]);
      // every switch a script uses must be declared, or $Switch.IsPresent throws
      const text = raw.toString('utf8');
      const declared = new Set([...text.matchAll(/\[switch\]\$([A-Za-z]+)/g)].map((m) => m[1]).filter((m): m is string => Boolean(m)));
      const used = new Set([...text.matchAll(/\$([A-Z][A-Za-z]+)\.IsPresent/g)].map((m) => m[1]).filter((m): m is string => Boolean(m)));
      for (const sw of used) expect(declared.has(sw), `${f}: $${sw}.IsPresent ohne [switch]$${sw} in param()`).toBe(true);
    }
  });
});
