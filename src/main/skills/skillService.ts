/**
 * Skills + learning — spec §18/§19/§65. Learning is *controlled*: corrections
 * are recorded as events; repeated, confirmed patterns become skill
 * candidates; the user reviews before promotion; skills are removable.
 * Skills never bypass permissions (tools go through the registry as always).
 */
import { newId, nowIso } from '../../shared/types/common.js';
import type { LearningEvent, Skill } from '../../shared/types/skills.js';
import { lexicalRelevance } from '../../shared/util/text.js';
import type { SubLogger } from '../core/logger.js';
import type { LearningEventRepo, SkillRepo } from '../storage/repositories.js';

/** Occurrences + confidence needed before a pattern becomes reviewable. */
const PROMOTION_THRESHOLD = 2;
const PROMOTION_CONFIDENCE = 0.6;

export class SkillService {
  constructor(
    private skills: SkillRepo,
    private learning: LearningEventRepo,
    private log: SubLogger,
  ) {}

  list(): Skill[] {
    return this.skills.list();
  }

  enabledSkills(): Skill[] {
    return this.skills.list().filter((s) => s.enabled);
  }

  /** Auto-select relevant skills for a task (§19 "dynamically discoverable"). */
  relevantFor(taskText: string, limit = 3): Skill[] {
    return this.enabledSkills()
      .map((s) => ({ s, score: lexicalRelevance(taskText, `${s.name} ${s.description} ${s.prerequisites.join(' ')}`) }))
      .filter((x) => x.score >= 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }

  upsert(skill: Skill): void {
    this.skills.upsert(skill);
  }

  createFromUser(input: {
    name: string;
    description: string;
    instructions: string;
    requiredTools?: string[];
    verification?: string;
  }): Skill {
    const at = nowIso();
    const skill: Skill = {
      id: newId('skill'),
      name: input.name,
      description: input.description,
      prerequisites: [],
      requiredTools: input.requiredTools ?? [],
      instructions: input.instructions,
      examples: [],
      verification: input.verification ?? 'ask the user whether the outcome matched',
      confidence: 1,
      version: 1,
      source: 'user_defined',
      enabled: true,
      createdAt: at,
      updatedAt: at,
    };
    this.skills.upsert(skill);
    return skill;
  }

  toggle(id: string, enabled: boolean): boolean {
    const s = this.skills.get(id);
    if (!s) return false;
    s.enabled = enabled;
    s.updatedAt = nowIso();
    this.skills.upsert(s);
    return true;
  }

  delete(id: string): boolean {
    return this.skills.delete(id);
  }

  // ---- learning pipeline (§65) ----

  listLearningEvents(): LearningEvent[] {
    return this.learning.listAll().map((r) => JSON.parse(r.json) as LearningEvent);
  }

  /** Record a user correction. Returns the (possibly merged) learning event. */
  recordCorrection(input: {
    key: string;
    previousBehavior: string;
    correction: string;
    context?: string;
    taskId?: string;
    projectId?: string;
  }): LearningEvent {
    const existing = this.listLearningEvents().find((e) => e.key === input.key && e.kind === 'correction' && !e.promotedSkillId);
    const at = nowIso();
    const ev: LearningEvent = existing
      ? ({
          ...existing,
          occurrences: existing.occurrences + 1,
          confidence: Math.min(1, existing.confidence + 0.2),
          correction: input.correction,
          context: input.context ?? existing.context,
          updatedAt: at,
        } as LearningEvent)
      : {
          id: newId('learn'),
          at,
          kind: 'correction',
          key: input.key,
          previousBehavior: input.previousBehavior,
          correction: input.correction,
          context: input.context,
          taskId: input.taskId,
          projectId: input.projectId,
          occurrences: 1,
          confidence: 0.4,
        };
    this.learning.upsert({
      id: ev.id,
      at: ev.at,
      kind: ev.kind,
      key: ev.key,
      occurrences: ev.occurrences,
      confidence: ev.confidence,
      promotedSkillId: ev.promotedSkillId,
      json: JSON.stringify(ev),
    });
    if (ev.occurrences >= PROMOTION_THRESHOLD && ev.confidence >= PROMOTION_CONFIDENCE) {
      this.log.info(`learning: "${ev.key}" reached promotion threshold — skill candidate ready for review`);
    }
    return ev;
  }

  /** Skill candidates that earned promotion but await user review (§18). */
  promotableCandidates(): LearningEvent[] {
    return this.listLearningEvents().filter(
      (e) => e.kind === 'correction' && !e.promotedSkillId && e.occurrences >= PROMOTION_THRESHOLD && e.confidence >= PROMOTION_CONFIDENCE,
    );
  }

  promoteToSkill(learningEventId: string, name?: string): Skill | null {
    const ev = this.listLearningEvents().find((e) => e.id === learningEventId);
    if (!ev) return null;
    const at = nowIso();
    const skill: Skill = {
      id: newId('skill'),
      name: name ?? `workflow:${ev.key.slice(0, 40)}`,
      description: ev.correction ?? ev.key,
      prerequisites: [],
      requiredTools: [],
      instructions: ev.correction ?? '',
      examples: ev.context ? [ev.context] : [],
      verification: 'user confirmed this behavior after a correction',
      confidence: ev.confidence,
      version: 1,
      source: 'learned',
      enabled: true,
      createdAt: at,
      updatedAt: at,
    };
    this.skills.upsert(skill);
    ev.promotedSkillId = skill.id;
    this.learning.upsert({
      id: ev.id,
      at: ev.at,
      kind: ev.kind,
      key: ev.key,
      occurrences: ev.occurrences,
      confidence: ev.confidence,
      promotedSkillId: skill.id,
      json: JSON.stringify(ev),
    });
    this.log.info(`learning: promoted "${ev.key}" to skill ${skill.id}`);
    return skill;
  }
}
