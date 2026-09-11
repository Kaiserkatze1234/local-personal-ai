/**
 * Prompt-as-you-type assistant — spec §20/§45. Deliberately lightweight:
 * heuristic analysis runs per call (no LLM); the optional model pass is
 * debounced, capped, and never touches the main agent. Suggestions are
 * advisory only; the user's prompt is never rewritten without consent.
 */

import { newId } from '../../shared/types/common.js';
import type { PromptSuggestion } from '../../shared/types/events.js';
import type { ConfigService } from '../core/config.js';
import type { SubLogger } from '../core/logger.js';
import type { ProjectService } from '../projects/projectService.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelRouter } from '../providers/router.js';

interface Pattern {
  re: RegExp;
  kind: PromptSuggestion['kind'];
  text: string;
  insertable?: string;
  lang?: 'en' | 'de' | 'any';
}

const PATTERNS: Pattern[] = [
  {
    re: /\b(faster|speed|optimize|performance|schneller|performanz|langsamer)\b/i,
    kind: 'add_detail',
    text: 'Which part is slow (startup, a screen, a specific operation)? Which symptom do you see, and is correctness or speed more important right now?',
    insertable: ' Slow part: ; Symptom: ; Priority: correctness/speed',
  },
  {
    re: /^\s*(make|fix|improve|change|update|mach|bau|änder|verbesser)\b/i,
    kind: 'missing_requirement',
    text: 'Possible missing requirement: the target — which file, project, or app should I work on?',
    insertable: ' in ',
  },
  {
    re: /\b(it|that|this|the app|das|es)\b/i,
    kind: 'ambiguity',
    text: 'Your request may have more than one interpretation — "it/that/this" could refer to several things. A concrete target removes the guesswork.',
    insertable: undefined,
  },
  {
    re: /\b(delete|remove|wipe|entfernen|löschen)\b/i,
    kind: 'missing_requirement',
    text: 'This mentions deletion. State the exact location/pattern so nothing unintended gets removed.',
    insertable: ' (only files matching: )',
  },
  {
    re: /\b(but|however|aber)\b/i,
    kind: 'contradiction',
    text: 'This sentence contains a contrast — double-check the two sides do not conflict (e.g. "keep it simple but add full coverage").',
  },
  {
    re: /\b(create|build|write|generate|mach|erstell|bau)\b.*\b(app|tool|script|page|ui|seite|tool)\b/i,
    kind: 'format_hint',
    text: 'For a build request, adding an output format helps: where should files go and in what language/framework?',
    insertable: ' Language: ; Output folder: ',
  },
  {
    re: /\?\s*$/,
    kind: 'format_hint',
    text: 'This is a question — do you want a short answer or a full explanation with steps?',
    insertable: ' (short answer)',
  },
  {
    re: /\b(how|wie)\b.*\bdo|make\b/i,
    kind: 'add_detail',
    text: 'Adding your current setup (OS, versions, what you already tried) makes the answer much more useful.',
    insertable: ' My setup: ',
  },
];

export class PromptAssistant {
  private lastCall = new Map<string, number>();

  constructor(
    private config: ConfigService,
    private projects: ProjectService,
    private log: SubLogger,
    private router?: ModelRouter,
    private providers?: ProviderRegistry,
  ) {}

  isEnabled(): boolean {
    return this.config.get().promptAssistant.enabled;
  }

  /**
   * Heuristic analysis (always cheap). Server-side throttle keeps even the
   * light path from running per keystroke if a client forgets to debounce.
   */
  analyze(inputId: string, text: string, projectId?: string, force = false): PromptSuggestion[] {
    if (!this.isEnabled()) return [];
    const trimmed = text.trim();
    if (!force) {
      const last = this.lastCall.get(inputId) ?? 0;
      if (Date.now() - last < this.config.get().promptAssistant.debounceMs) return this.cached(inputId) ?? [];
      this.lastCall.set(inputId, Date.now());
    }
    const suggestions: PromptSuggestion[] = [];
    if (trimmed.length > 4) {
      for (const p of PATTERNS) {
        if (p.re.test(trimmed)) suggestions.push({ id: newId('sug'), kind: p.kind, text: p.text, insertable: p.insertable });
      }
      if (trimmed.length < 24 && /\b(help|fix|do this|mach das|brauch)\b/i.test(trimmed)) {
        suggestions.push({
          id: newId('sug'),
          kind: 'missing_requirement',
          text: 'Very short request — one concrete sentence about the goal usually beats five clarifying questions.',
          insertable: undefined,
        });
      }
      // related files/projects from the index — cheap filename match only (§32)
      if (/\.(ts|tsx|js|jsx|py|rs|go|md|json|txt|html|css)\b/i.test(trimmed)) {
        const nameMatch = /([A-Za-z0-9_\-./]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|txt|html|css))\b/i.exec(trimmed);
        if (nameMatch?.[1] && projectId) {
          const rel = this.projects.list().find((p) => p.id === projectId);
          void rel; // file existence check delegated to indexer search when available
          suggestions.push({
            id: newId('sug'),
            kind: 'related_files',
            text: `You referenced ${nameMatch[1]} — the active project will be searched for it automatically; confirm the project if it is elsewhere.`,
          });
        }
      }
    }
    const capped = suggestions.slice(0, 3); // never nag with more (§45)
    this.setCache(inputId, capped);
    return capped;
  }

  /** Optional small-model refinement — only when enabled and bound; never blocks typing. */
  async analyzeWithModel(text: string, _projectId?: string): Promise<PromptSuggestion[] | null> {
    const cfg = this.config.get();
    if (!cfg.promptAssistant.enabled || !cfg.promptAssistant.useModel || !this.router || !this.providers) return null;
    try {
      const decision = this.router.select('prompt_assistant', 'prompt_assist', { preferSmall: true });
      const { provider } = this.providers.chatFor(decision.modelId);
      const res = await provider.adapter.chat?.generate({
        modelId: decision.modelId,
        messages: [
          {
            role: 'system',
            content:
              'You review a user draft request to an AI assistant. List at most 3 short, concrete things the draft is missing or ambiguous. Output JSON: {"suggestions":[{"text":"...","insertable":"..."}]} or {"suggestions":[]} if clear.',
          },
          { role: 'user', content: text },
        ],
        jsonMode: decision.model.capabilities.includes('structured_output'),
        maxTokens: 220,
      });
      if (!res?.text) return null;
      const parsed = JSON.parse(res.text) as { suggestions?: { text: string; insertable?: string }[] };
      return (parsed.suggestions ?? [])
        .slice(0, 3)
        .map((s) => ({ id: newId('sug'), kind: 'add_detail' as const, text: s.text.slice(0, 300), insertable: s.insertable }));
    } catch (err) {
      this.log.debug(`prompt model pass skipped: ${(err as Error).message}`);
      return null;
    }
  }

  private cache = new Map<string, { at: number; items: PromptSuggestion[] }>();
  private cached(id: string): PromptSuggestion[] | null {
    const c = this.cache.get(id);
    return c && Date.now() - c.at < 10_000 ? c.items : null;
  }
  private setCache(id: string, items: PromptSuggestion[]): void {
    this.cache.set(id, { at: Date.now(), items });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
  }
}
