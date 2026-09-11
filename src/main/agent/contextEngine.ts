/**
 * Context engine — spec §29/§30/§54. Collects candidate context from all
 * sources, ranks it, fits it to a token budget, and keeps source refs so the
 * UI can explain where information came from (§63). Everything injected is
 * compact, deduplicated, fresh — "retrieve, never dump".
 */

import type { ContextBuildRequest, ContextItem } from '../../shared/types/context.js';
import type { ChatMessage } from '../../shared/types/models.js';
import { estimateTokens } from '../../shared/util/text.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { ProjectService } from '../projects/projectService.js';
import type { SkillService } from '../skills/skillService.js';
import type { ConversationRepo, MessageRepo } from '../storage/repositories.js';

export interface BuiltContext {
  items: ContextItem[];
  totalTokens: number;
  budget: number;
  dropped: string[];
  /** For the transparency panel: "context used for this turn". */
  summary: string;
}

export class ContextEngine {
  constructor(
    private memory: MemoryService,
    private skills: SkillService,
    private projects: ProjectService,
    private conversations: ConversationRepo,
    private messages: MessageRepo,
    private config: ConfigService,
    private log: SubLogger,
    /** Provided by the screen module when a capture exists (ephemeral). */
    private getScreenContext?: () => Promise<string | null>,
  ) {}

  async build(req: ContextBuildRequest): Promise<BuiltContext> {
    const cfg = this.config.get();
    const budget =
      (req.taskClass === 'chat' || req.taskClass === 'informational' ? cfg.ai.contextTokenBudget : cfg.ai.agentContextTokenBudget) *
      (cfg.performance.mode === 'LOW_RESOURCE' ? 0.6 : 1);
    const candidates: ContextItem[] = [];
    const add = (item: Omit<ContextItem, 'estimatedTokens'>): void => {
      candidates.push({ ...item, estimatedTokens: estimateTokens(item.content) });
    };

    // 1) recent conversation (fresh, newest last)
    if (req.conversationId) {
      const msgs = this.messages.list(req.conversationId, 40).filter((m) => m.role === 'user' || m.role === 'assistant');
      let used = 0;
      const take: ChatMessage[] = [];
      for (let i = msgs.length - 1; i >= 0 && used < budget * 0.45; i--) {
        const m = msgs[i] as ChatMessage;
        const t = estimateTokens(this.messageText(m));
        if (used + t > budget * 0.45) break;
        used += t;
        take.unshift(m);
      }
      for (const m of take) {
        add({
          source: 'conversation',
          ref: m.id ?? 'msg',
          relevance: 0.9,
          label: m.role,
          content: this.messageText(m),
          fresh: true,
          pinned: m === take[take.length - 1],
        });
      }
      // older-turn summary if the conversation repo has one (§17 style compression)
      const conv = this.conversations.list().find((c) => c.id === req.conversationId);
      if (conv?.summary && take.length < msgs.length) {
        add({
          source: 'conversation',
          ref: `summary:${conv.id}`,
          relevance: 0.55,
          label: 'earlier summary',
          content: conv.summary,
          fresh: false,
        });
      }
    }

    // 2) memory hits (§64 ranking inside the service)
    if (cfg.memory.enabled) {
      const hits = await this.memory.search(req.userText, { projectId: req.projectId, limit: 5 });
      for (const h of hits) {
        add({
          source: 'memory',
          ref: h.entry.id,
          relevance: 0.35 + 0.4 * h.score,
          label: `memory:${h.entry.type}`,
          content: h.entry.content,
          fresh: false,
        });
      }
    }

    // 3) project-aware context (§13/§54: relevant files, not the repo dump)
    if (
      req.projectId &&
      (req.taskClass === 'coding' || req.taskClass === 'debugging' || req.taskClass === 'code_review' || req.taskClass === 'informational')
    ) {
      const brief = this.projects.projectBrief(req.projectId);
      if (brief)
        add({ source: 'project', ref: brief.project.id, relevance: 0.85, label: 'project overview', content: brief.overview, fresh: true });
      const relFiles = await this.projects.relevantFiles(req.projectId, req.userText, req.taskClass === 'coding' ? 6 : 4);
      for (const f of relFiles) {
        add({ source: 'file', ref: f.path, relevance: 0.3 + 0.5 * f.score, label: f.rel, content: f.preview, fresh: true });
      }
    }

    // 4) matching skills (§19 auto-select)
    const skillHits = this.skills.relevantFor(req.userText, 2);
    for (const s of skillHits) {
      add({
        source: 'skill',
        ref: s.id,
        relevance: 0.6,
        label: `skill:${s.name}`,
        content: `${s.description}\n${s.instructions}`.trim(),
        fresh: true,
      });
    }

    // 5) screen context only on request and only if ephemeral capture exists
    if (req.includeScreen && this.getScreenContext) {
      const shot = await this.getScreenContext().catch(() => null);
      if (shot)
        add({ source: 'screen', ref: 'screen:last-capture', relevance: 0.75, label: 'screen description', content: shot, fresh: true });
    }

    // rank, dedup by ref, fit budget
    candidates.sort((a, b) => b.relevance - a.relevance);
    const seenRefs = new Set<string>();
    const kept: ContextItem[] = [];
    const dropped: string[] = [];
    let used = 0;
    for (const c of candidates) {
      const key = `${c.source}:${c.ref}:${c.label}`;
      if (seenRefs.has(key)) {
        dropped.push(`${c.source} ${c.label} (duplicate)`);
        continue;
      }
      if (used + c.estimatedTokens > budget && !c.pinned) {
        dropped.push(`${c.source} ${c.label}`);
        continue;
      }
      seenRefs.add(key);
      kept.push(c);
      used += c.estimatedTokens;
      if (used >= budget) break;
    }

    // §30: pinned content (last user message, task state) is never silently dropped
    const droppedPinned = dropped.filter((d) => d.includes('summary'));
    if (droppedPinned.length > 0) this.log.warn(`context budget squeezed ${droppedPinned.length} item(s) worth reviewing`);

    return {
      items: kept,
      totalTokens: used,
      budget,
      dropped,
      summary: `${kept.length} item(s), ~${used} tokens of ${Math.round(budget)} budget${dropped.length > 0 ? `; ${dropped.length} dropped` : ''}`,
    };
  }

  /** Compose the context block placed before the user request (§63). */
  renderContextBlock(ctx: BuiltContext): string {
    if (ctx.items.length === 0) return '';
    const bySource: Record<string, ContextItem[]> = {};
    for (const i of ctx.items) (bySource[i.source] ??= []).push(i);
    const out: string[] = ['<context>'];
    const section = (title: string, items: ContextItem[]): void => {
      if (items.length === 0) return;
      out.push(`<${title}>`);
      for (const i of items) out.push(`[${i.ref}] ${i.content}`);
      out.push(`</${title}>`);
    };
    section('project', bySource['project'] ?? []);
    section(
      'files',
      (bySource['file'] ?? []).map((i) => ({ ...i, content: `<file path="${i.ref}">\n${i.content}\n</file>` })),
    );
    section('memory', bySource['memory'] ?? []);
    section(
      'skills',
      (bySource['skill'] ?? []).map((i) => ({
        ...i,
        content: `Follow this learned workflow if applicable — never skip permission checks:\n${i.content}`,
      })),
    );
    section('screen', bySource['screen'] ?? []);
    section(
      'earlier-conversation',
      (bySource['conversation'] ?? []).filter((i) => i.label === 'earlier summary'),
    );
    out.push('</context>');
    return out.join('\n');
  }

  private messageText(m: ChatMessage): string {
    if (typeof m.content === 'string') return m.content;
    return m.content.map((p) => (p.type === 'text' ? p.text : `[image ${p.mimeType}]`)).join(' ');
  }

  /** Personality/system prompt (§60) — configurable, accuracy-first. */
  systemPrompt(
    taskClass: ContextBuildRequest['taskClass'],
    persona: { verbosity: string; formality: string; technicalDepth: string },
    language = 'de',
  ): string {
    const lines = [
      `You are ${'"Local Personal AI"'}, a local assistant running on the user's own machine.`,
      `Verbosity: ${persona.verbosity}. Formality: ${persona.formality}. Technical depth: ${persona.technicalDepth}.`,
      // general.language decides the default response language ('off' disables the rule)
      ...(language === 'off'
        ? []
        : [
            `Default reply language: ${language === 'de' ? 'Deutsch (German)' : language}. Write prose, explanations and summaries in it. If the user clearly writes another language, mirror the user's language. Keep code, commands, file paths, identifiers and log output untranslated.`,
            'Match this language for memory notes and skill descriptions you create.',
          ]),
      'Never claim to have performed an action you did not perform; never claim success without verification.',
      'If a capability is unavailable, say so plainly and explain what would enable it.',
      'If a request is ambiguous and the ambiguity is harmless, state your assumption briefly and proceed; if it could cause an important or destructive action, ask first.',
    ];
    if (taskClass === 'coding' || taskClass === 'debugging') {
      lines.push(
        'You are working in a real project. Inspect before editing; make the smallest reasonable change; verify with tests/build when available; summarize changed files.',
      );
    }
    return lines.join('\n');
  }
}
