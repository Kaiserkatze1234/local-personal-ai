/**
 * System/knowledge tools — spec §10 (inspect resources, provider health,
 * memory/knowledge search). All return structured data, never raw dumps.
 */

import type { HealthService } from '../diagnostics/healthService.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { ResourceManager } from '../resources/resourceManager.js';
import type { FileIndexRepo, KnowledgeRepo } from '../storage/repositories.js';
import type { ToolRegistry } from './registry.js';

export function registerSystemTools(
  registry: ToolRegistry,
  deps: {
    health: () => HealthService;
    memory: () => MemoryService;
    knowledge: () => KnowledgeRepo;
    fileIndex: () => FileIndexRepo;
    resources: () => ResourceManager;
  },
): void {
  registry.register(
    {
      name: 'get_resource_status',
      description: 'Current CPU/RAM/GPU load and resource mode. Use before heavy operations.',
      inputSchema: { type: 'object', properties: {} },
      permission: null,
      mutating: false,
      phase: 4,
    },
    async () => {
      const snap = deps.resources().snapshot();
      return {
        ok: true,
        summary: `mode ${snap.resourceMode}, mem ${snap.memUsedMb}/${snap.memTotalMb} MB, cpu ${snap.cpuPercent ?? '?'}%`,
        data: snap,
      };
    },
  );

  registry.register(
    {
      name: 'check_provider_health',
      description: 'Health and model list of configured AI providers.',
      inputSchema: { type: 'object', properties: {} },
      permission: null,
      mutating: false,
      phase: 4,
    },
    async () => {
      const report = await deps.health().run();
      const providers = report.components.filter((c) => c.id.startsWith('provider.'));
      const bad = providers.filter((c) => c.state !== 'OK');
      return {
        ok: bad.length === 0,
        summary:
          bad.length === 0
            ? `All ${providers.length} provider(s) healthy`
            : bad.map((b) => `${b.id}: ${b.state} — ${b.message}`).join('; '),
        data: { providers, overall: report.overall },
      };
    },
  );

  registry.register(
    {
      name: 'search_memory',
      description: 'Search long-term memory (preferences, facts, past task outcomes) for information relevant to the current request.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer' } },
        required: ['query'],
      },
      permission: null,
      mutating: false,
      phase: 7,
    },
    async (input) => {
      if (!deps.memory().isEnabled()) return { ok: true, summary: 'Memory is disabled in settings.', data: { hits: [] } };
      const hits = await deps.memory().search(String(input.query ?? ''), { limit: Math.min(10, Number(input.limit ?? 5)) });
      return {
        ok: true,
        summary: `${hits.length} relevant memor${hits.length === 1 ? 'y' : 'ies'}`,
        data: {
          hits: hits.map((h) => ({
            content: h.entry.content,
            type: h.entry.type,
            score: Math.round(h.score * 100) / 100,
            scope: h.entry.scope.kind,
          })),
        },
      };
    },
  );

  registry.register(
    {
      name: 'search_knowledge',
      description: 'Search imported documents (knowledge base) for a phrase.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
      permission: null,
      mutating: false,
      phase: 7,
    },
    async (input) => {
      const rows = deps.knowledge().search(String(input.query ?? ''), 8);
      return {
        ok: true,
        summary: `${rows.length} chunk(s) match`,
        data: { hits: rows.map((r) => ({ doc: r.name, kind: r.kind, idx: r.idx, text: r.text.slice(0, 400) })) },
      };
    },
  );

  registry.register(
    {
      name: 'search_indexed_files',
      description: 'Search the global file index by filename (metadata-only index; content is never indexed without explicit import).',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
      permission: 'fs.read',
      mutating: false,
      phase: 7,
    },
    async (input) => {
      const rows = deps.fileIndex().search(String(input.name ?? ''), 30);
      return { ok: true, summary: `${rows.length} indexed file(s) match`, data: { files: rows } };
    },
  );
}
