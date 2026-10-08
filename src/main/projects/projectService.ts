/**
 * Project understanding — spec §13/§14. Discovers project type, languages,
 * frameworks, entry points, scripts, tests; indexes files incrementally
 * (mtime-based, §13 "changed file must not force a full re-index"); provides
 * ranked relevant-file retrieval for coding tasks.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newId, nowIso } from '../../shared/types/common.js';
import type { ProjectInfo } from '../../shared/types/ipc.js';
import { lexicalRelevance, truncateMiddle } from '../../shared/util/text.js';
import type { SubLogger } from '../core/logger.js';
import { walkFiles } from '../files/walk.js';
import type { BackgroundJobQueue } from '../indexing/backgroundQueue.js';
import type { ProjectRepo } from '../storage/repositories.js';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  php: 'php',
  rb: 'ruby',
  vue: 'vue',
  svelte: 'svelte',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  sh: 'shell',
  ps1: 'powershell',
  bat: 'batch',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  md: 'markdown',
};

const FRAMEWORK_HINTS: [RegExp, string][] = [
  [/\breact\b/, 'react'],
  [/\bnext\b/, 'next.js'],
  [/\bvite\b/, 'vite'],
  [/\bvue\b/, 'vue'],
  [/\bsvelte\b/, 'svelte'],
  [/\bexpress\b/, 'express'],
  [/\bnest\b/, 'nestjs'],
  [/\belectron\b/, 'electron'],
  [/\bfastapi\b/, 'fastapi'],
  [/\bdjango\b/, 'django'],
  [/\bflask\b/, 'flask'],
  [/\bpandas\b/, 'pandas'],
  [/\btokio\b/, 'tokio'],
  [/\bactix\b/, 'actix'],
  [/\bgorm\b/, 'gorm'],
  [/\bspring\b/, 'spring'],
];

const IGNORED_NAME_RE = /\.(min\.js|map|lock|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|pdf|zip|exe|dll|pyc)$/i;

interface ProjectMeta {
  kind: string;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  scripts: Record<string, string>;
  testCommands: string[];
  isGit: boolean;
}

export interface RankedFile {
  path: string;
  rel: string;
  score: number;
  preview: string;
  role: string;
}

export class ProjectService {
  constructor(
    private repo: ProjectRepo,
    private log: SubLogger,
    private jobs: BackgroundJobQueue,
  ) {}

  async addProject(rawPath: string): Promise<ProjectInfo> {
    const path = resolve(rawPath);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
    const id = newId('proj');
    const brief = this.detect(path);
    const info: ProjectInfo = {
      id,
      path,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      kind: brief.kind,
      languages: brief.languages,
      frameworks: brief.frameworks,
      entryPoints: brief.entryPoints,
      scripts: brief.scripts,
      testCommands: brief.testCommands,
      fileCount: 0,
      lastIndexedAt: undefined,
      isGit: brief.isGit,
    };
    this.repo.upsert({ id, path, name: info.name, kind: info.kind, json: JSON.stringify(info), createdAt: nowIso() });
    await this.indexProject(id, true);
    return (await this.get(id)) ?? info;
  }

  list(): ProjectInfo[] {
    return this.repo.list().map((r) => JSON.parse(r.json) as ProjectInfo);
  }

  async get(id: string): Promise<ProjectInfo | null> {
    return this.list().find((p) => p.id === id) ?? null;
  }

  remove(id: string): boolean {
    const p = this.list().find((x) => x.id === id);
    if (!p) return false;
    this.repo.remove(id);
    return true;
  }

  /** Manifest + tree sniffing — no LLM required (§13). */
  private detect(root: string): ProjectMeta {
    const meta: ProjectMeta = {
      kind: 'generic',
      languages: [],
      frameworks: [],
      entryPoints: [],
      scripts: {},
      testCommands: [],
      isGit: existsSync(join(root, '.git')),
    };
    const readOpt = (p: string): string | null => {
      try {
        return readFileSync(join(root, p), 'utf8');
      } catch {
        return null;
      }
    };
    const pkg = readOpt('package.json');
    const pyproject = readOpt('pyproject.toml');
    const cargo = readOpt('Cargo.toml');
    const gomod = readOpt('go.mod');
    const csproj = readOpt('*.csproj') ?? null;
    void csproj;
    if (pkg) {
      meta.kind = 'node';
      try {
        const j = JSON.parse(pkg) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
          main?: string;
          bin?: string | Record<string, string>;
        };
        meta.scripts = j.scripts ?? {};
        const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
        for (const [pattern, name] of FRAMEWORK_HINTS) if (Object.keys(deps).some((d) => pattern.test(d))) meta.frameworks.push(name);
        if (j.main) meta.entryPoints.push(j.main);
        if (typeof j.bin === 'string') meta.entryPoints.push(j.bin);
        else if (j.bin) meta.entryPoints.push(...Object.values(j.bin));
        if (meta.scripts.test) meta.testCommands.push(`npm test`);
        if (deps.typescript) meta.testCommands.unshift('npx tsc --noEmit');
      } catch {
        /* malformed package.json is itself a signal */
      }
    } else if (pyproject) {
      meta.kind = 'python';
      if (/fastapi/i.test(pyproject)) meta.frameworks.push('fastapi');
      if (/django/i.test(pyproject)) meta.frameworks.push('django');
      meta.testCommands.push('pytest');
      for (const e of ['main.py', 'app.py', 'manage.py', 'src/main.py']) if (existsSync(join(root, e))) meta.entryPoints.push(e);
    } else if (cargo) {
      meta.kind = 'rust';
      meta.testCommands.push('cargo test');
      meta.entryPoints.push('src/main.rs', 'src/lib.rs');
    } else if (gomod) {
      meta.kind = 'go';
      meta.testCommands.push('go test ./...');
      if (existsSync(join(root, 'main.go'))) meta.entryPoints.push('main.go');
    } else if (existsSync(join(root, 'index.html'))) {
      meta.kind = 'static-web';
      meta.entryPoints.push('index.html');
    }
    return meta;
  }

  reindex(id: string): boolean {
    this.jobs.enqueue({ label: `reindex ${id}`, priority: 5, run: () => this.indexProject(id, false) });
    return true;
  }

  /** Incremental file index (symbols + preview per file). Returns counts. */
  async indexProject(id: string, initial: boolean): Promise<{ indexed: number; updated: number; removed: number }> {
    const project = await this.get(id);
    if (!project) throw new Error(`Unknown project ${id}`);
    const entries = walkFiles(project.path, { maxEntries: 8000, maxDepth: 14, skipGenerated: true });
    const files = entries.filter((e) => !e.isDir && !IGNORED_NAME_RE.test(e.relPath) && e.size <= 1024 * 1024);
    const existing = new Map(this.repo.files(id).map((f) => [f.path, f]));
    const toStore: Parameters<ProjectRepo['upsertFiles']>[1] = [];
    let updated = 0;
    for (const f of files) {
      const prev = existing.get(f.absPath);
      if (!initial && prev && prev.mtime_ms === f.mtimeMs && prev.size === f.size) continue; // unchanged (§13)
      if (prev) updated++;
      let preview = '';
      let symbols: string[] = [];
      try {
        const raw = readFileSync(f.absPath, 'utf8');
        symbols = extractSymbols(raw, this.langFor(f.relPath));
        preview = truncateMiddle(raw, 1400);
      } catch {
        preview = '';
      }
      const ext = f.relPath.split('.').pop() ?? '';
      toStore.push({
        path: f.absPath,
        rel: f.relPath,
        size: f.size,
        mtimeMs: f.mtimeMs,
        lang: EXT_LANG[ext] ?? ext,
        role: classifyFileRole(f.relPath),
        symbolsJson: JSON.stringify(symbols),
        preview,
      });
    }
    if (toStore.length > 0) this.repo.upsertFiles(id, toStore);
    if (initial)
      this.repo.removeFilesNotIn(
        id,
        files.map((f) => f.absPath),
      );
    const allCount = this.repo.files(id).length;
    const info = { ...project, fileCount: allCount, lastIndexedAt: nowIso() };
    this.repo.upsert({
      id: project.id,
      path: project.path,
      name: project.name,
      kind: project.kind,
      json: JSON.stringify(info),
      createdAt: nowIso(),
      lastIndexedAt: info.lastIndexedAt,
    });
    this.log.info(`project ${project.name}: ${toStore.length} file(s) written (${updated} updated), ${allCount} total`);
    return { indexed: toStore.length, updated, removed: 0 };
  }

  private langFor(rel: string): string {
    const ext = rel.split('.').pop() ?? '';
    return EXT_LANG[ext] ?? ext;
  }

  /** Human-readable overview block for the agent (§13 "project as a system"). */
  projectBrief(projectId: string): { project: ProjectInfo; overview: string } | null {
    const project = this.list().find((p) => p.id === projectId);
    if (!project) return null;
    const important = this.repo
      .files(projectId)
      .filter((f) => f.role === 'entry' || f.role === 'test' || f.role === 'config' || f.role === 'docs')
      .slice(0, 24);
    const lines = [
      `Project "${project.name}" at ${project.path}`,
      `kind: ${project.kind}; files indexed: ${project.fileCount}; git: ${project.isGit ? 'yes' : 'no'}`,
      `languages: ${project.languages.join(', ') || '(not yet detected — run a reindex)'}`,
      `frameworks: ${project.frameworks.join(', ') || '-'}`,
      `entry points: ${project.entryPoints.join(', ') || '-'}`,
      `scripts: ${
        Object.entries(project.scripts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ') || '-'
      }`,
      `verification commands available: ${project.testCommands.join(' | ') || 'NONE — changes cannot be auto-verified here'}`,
      `notable files: ${important.map((f) => f.rel).join(', ') || '-'}`,
    ];
    return { project, overview: lines.join('\n') };
  }

  /** Rank files for a request using filename/symbol/preview lexical score. */
  async relevantFiles(projectId: string, query: string, limit: number): Promise<RankedFile[]> {
    const rows = this.repo.files(projectId);
    if (rows.length === 0) return [];
    const scored = rows
      .map((f) => {
        let symbols: string[] = [];
        try {
          symbols = f.symbols_json ? (JSON.parse(f.symbols_json) as string[]) : [];
        } catch {
          /* ignore */
        }
        const score =
          0.5 * lexicalRelevance(query, `${f.rel} ${symbols.join(' ')}`) +
          0.3 * lexicalRelevance(query, f.text_preview ?? '') +
          (f.role === 'entry' ? 0.08 : 0) +
          (f.role === 'test' ? 0.04 : 0);
        return { path: f.path, rel: f.rel, score, preview: f.text_preview ?? '', role: f.role ?? 'source' } as RankedFile;
      })
      .filter((f) => f.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    // refresh full content preview for the top pick so entry-point reads are current
    for (const f of scored.slice(0, 2)) {
      try {
        if (statSync(f.path).size <= 64 * 1024) f.preview = truncateMiddle(readFileSync(f.path, 'utf8'), 6000);
      } catch {
        /* file vanished */
      }
    }
    return scored;
  }
}

/** Cheap regex-based symbol extraction (functions/classes/defs/imports). */
export function extractSymbols(text: string, lang: string): string[] {
  const out = new Set<string>();
  const patterns: RegExp[] =
    lang === 'python'
      ? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm, /^\s*(?:from\s+[\w.]+\s+)?import\s+([\w, ]+)/gm]
      : lang === 'rust'
        ? [/\b(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/g, /^\s*use\s+([^;]+);/gm]
        : lang === 'go'
          ? [/func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, /type\s+([A-Za-z_]\w*)/g, /^import\s+/gm]
          : [
              /(?:function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
              /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g,
              /^import\s+(?:[\w*\s{},]+from\s+)?['"]([^'"]+)['"]/gm,
              /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm,
            ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let guard = 0;
    while ((m = r.exec(text)) !== null && guard++ < 40) {
      const sym = m[1] ?? m[0];
      if (sym && sym.length <= 60) out.add(sym.trim());
      if (r.lastIndex === 0) r.lastIndex++; // safety vs zero-length
    }
  }
  return [...out].slice(0, 40);
}

export function classifyFileRole(rel: string): 'entry' | 'test' | 'config' | 'docs' | 'source' {
  const base = rel.split('/').pop() ?? '';
  if (/^(index|main|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs)$/.test(base)) return 'entry';
  if (
    /\.(test|spec)\.[jt]sx?$/.test(base) ||
    /(^|\/)(tests?|__tests__)\//.test(rel) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.go$/.test(base)
  )
    return 'test';
  if (/\.(json|ya?ml|toml|ini|env)$/.test(base) || /^(package\.json|tsconfig.*|pyproject\.toml|Cargo\.toml|go\.mod|Makefile)$/.test(base))
    return 'config';
  if (/\.md$/i.test(base) || /^(readme|docs?|changelog|license)/i.test(base)) return 'docs';
  return 'source';
}
