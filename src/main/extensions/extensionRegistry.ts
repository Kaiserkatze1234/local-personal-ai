/**
 * Extensions — spec §42. New capabilities arrive as modules, never as core
 * edits. A module = manifest (name, version, capabilities, permissions,
 * dependencies) + activate(context). Activated extensions may contribute
 * tools, importers and skills through the typed context; unloading runs
 * their dispose and revokes their session grants. No remote/plugin store
 * magic — manifests are validated, dependencies resolved, permissions listed
 * for the user to see (§42 "must declare").
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PermissionId } from '../../shared/types/permissions.js';
import type { ToolResult } from '../../shared/types/tools.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { Importer } from '../files/importers.js';
import { registerImporter, unregisterImportersByPrefix } from '../files/importers.js';
import type { PermissionService } from '../permissions/permissionService.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** What the extension provides: 'tool' | 'importer' | 'skill' | 'provider'. */
  capabilities: string[];
  /** Permissions its tools require — surfaced to the user before activation. */
  permissions: PermissionId[];
  /** Other extension ids that must be installed first. */
  dependencies: string[];
  /** For disk extensions: module entry file (default main.mjs). */
  main?: string;
}

export interface ExtensionContext {
  addTool(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    permission: PermissionId | null;
    mutating: boolean;
    run: (input: Record<string, unknown>, ctx: import('../tools/registry.js').ToolRunContext) => Promise<ToolResult>;
  }): void;
  addImporter(importer: Importer): void;
  notify(text: string): void;
  log: SubLogger;
}

export type ExtensionActivate = (ctx: ExtensionContext) => (() => void) | undefined;

export interface ExtensionState {
  manifest: ExtensionManifest;
  active: boolean;
  error?: string;
  activatedAt?: string;
  contributedTools: string[];
  contributedImporters: number;
  /** Set when the extension came from disk; uninstall drops a .disabled marker there. */
  sourceDir?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{1,40}$/;
const VER_RE = /^\d+\.\d+(\.\d+)?(-[\w.]+)?$/;

export function validateManifest(m: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(m.id)) errors.push(`id "${m.id}" must match ${ID_RE}`);
  if (!m.name?.trim()) errors.push('name required');
  if (!VER_RE.test(m.version)) errors.push(`version "${m.version}" must look like 1.2.3`);
  if (!Array.isArray(m.capabilities)) errors.push('capabilities must be an array');
  if (!Array.isArray(m.permissions)) errors.push('permissions must be an array');
  if (!Array.isArray(m.dependencies)) errors.push('dependencies must be an array');
  return errors;
}

export class ExtensionRegistry {
  private states = new Map<string, ExtensionState>();
  private disposes = new Map<string, () => void>();

  constructor(
    private tools: ToolRegistry,
    private permissions: PermissionService,
    private log: SubLogger,
  ) {}

  list(): ExtensionState[] {
    return [...this.states.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): ExtensionState | null {
    return this.states.get(id) ?? null;
  }

  /** Install + activate in one step; a failing activate records the error and uninstalls. */
  install(manifest: ExtensionManifest, activate: ExtensionActivate): ExtensionState {
    const errors = validateManifest(manifest);
    if (errors.length > 0) throw AppError.invalidState(`Extension manifest invalid: ${errors.join('; ')}`);
    if (this.states.has(manifest.id)) throw AppError.invalidState(`Extension "${manifest.id}" already installed`);
    for (const dep of manifest.dependencies) {
      if (!this.states.get(dep)?.active) throw AppError.invalidState(`Extension "${manifest.id}" requires "${dep}" to be installed first`);
    }
    const state: ExtensionState = { manifest, active: false, contributedTools: [], contributedImporters: 0 };
    this.states.set(manifest.id, state);
    const ctx: ExtensionContext = {
      addTool: (t) => {
        // extension tools are namespaced so they can never shadow core tools
        const name = `${manifest.id}_${t.name}`.slice(0, 64);
        if (t.permission && !manifest.permissions.includes(t.permission)) {
          throw AppError.invalidState(`extension tool "${t.name}" requires "${t.permission}" which its manifest does not declare`);
        }
        this.tools.register(
          {
            name,
            description: `[ext ${manifest.name} ${manifest.version}] ${t.description}`,
            inputSchema: t.inputSchema,
            permission: t.permission,
            mutating: t.mutating,
          },
          t.run,
        );
        state.contributedTools.push(name);
      },
      addImporter: (importer) => {
        registerImporter(importer);
        state.contributedImporters++;
      },
      notify: (text) => this.log.info(`[${manifest.id}] ${text}`),
      log: this.log,
    };
    try {
      const dispose = activate(ctx);
      state.active = true;
      state.activatedAt = new Date().toISOString();
      if (typeof dispose === 'function') this.disposes.set(manifest.id, dispose);
      this.log.info(
        `extension "${manifest.name}" ${manifest.version} activated (${state.contributedTools.length} tool(s), ${state.contributedImporters} importer(s))`,
      );
    } catch (err) {
      this.uninstall(manifest.id);
      this.states.set(manifest.id, { ...state, active: false, error: (err as Error).message });
      throw AppError.invalidState(`Extension failed to activate: ${(err as Error).message}`);
    }
    return state;
  }

  /**
   * §42: scan `<dir>/<id>/` for `manifest.json` + module entry (manifest's
   * `main`, default `main.mjs`), validate and activate. Folders containing an
   * `<id>.disabled` marker (left by uninstall) are skipped until it is
   * removed. Errors are collected per-extension — one bad module can never
   * break boot.
   */
  async loadFromDirectory(dir: string): Promise<{ loaded: string[]; skipped: string[]; errors: { id: string; error: string }[] }> {
    const loaded: string[] = [];
    const skipped: string[] = [];
    const errors: { id: string; error: string }[] = [];
    if (!existsSync(dir)) return { loaded, skipped, errors };
    for (const entry of readdirSync(dir)) {
      const extDir = join(dir, entry);
      try {
        if (!statSync(extDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(extDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      if (existsSync(join(extDir, `${entry}.disabled`))) {
        skipped.push(entry);
        continue;
      }
      if (this.states.has(entry)) continue; // already active from a previous load
      let manifest: ExtensionManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
        if (!manifest.id) manifest = { ...manifest, id: entry };
      } catch (err) {
        errors.push({ id: entry, error: `manifest.json unreadable: ${(err as Error).message}` });
        continue;
      }
      const mainFile = join(extDir, /^[\w./-]+$/.test(manifest.main ?? '') ? (manifest.main ?? 'main.mjs') : 'main.mjs');
      if (!existsSync(mainFile)) {
        errors.push({ id: entry, error: 'module entry not found (expected main.mjs)' });
        continue;
      }
      try {
        const mod = (await import(pathToFileURL(mainFile).href)) as { default?: ExtensionActivate };
        if (typeof mod.default !== 'function') throw new Error('module must default-export an activate function');
        const state = this.install(manifest, mod.default);
        state.sourceDir = extDir;
        loaded.push(entry);
      } catch (err) {
        errors.push({ id: entry, error: (err as Error).message });
      }
    }
    return { loaded, skipped, errors };
  }

  /** True if the id came from disk and still has its folder (for re-enable UX). */
  hasDiskSource(id: string): boolean {
    return this.states.get(id)?.sourceDir !== undefined;
  }

  directoryOf(id: string): string | null {
    return this.states.get(id)?.sourceDir ?? null;
  }

  uninstall(id: string): boolean {
    const state = this.states.get(id);
    if (!state) return false;
    const dependents = [...this.states.values()].filter((s) => s.active && s.manifest.dependencies.includes(id));
    if (dependents.length > 0)
      throw AppError.invalidState(`Cannot remove "${id}": still required by ${dependents.map((d) => d.manifest.id).join(', ')}`);
    this.disposes.get(id)?.();
    this.disposes.delete(id);
    for (const toolName of state.contributedTools) this.tools.unregister(toolName);
    if (state.contributedImporters > 0) unregisterImportersByPrefix(`${id}:`);
    this.permissions?.revokeSessionGrantsFor(state.manifest.permissions);
    if (state.sourceDir) {
      try {
        writeFileSync(join(state.sourceDir, `${id}.disabled`), new Date().toISOString(), 'utf8');
      } catch {
        /* read-only folder: still uninstalled for this session */
      }
    }
    this.states.delete(id);
    return true;
  }
}
