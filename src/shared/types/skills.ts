/** Skills + learning — spec §18/§19/§65. */

export interface Skill {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  /** Tool names this skill requires; skills never bypass permissions (§19). */
  requiredTools: string[];
  instructions: string;
  examples: string[];
  /** How to verify the skill worked. */
  verification: string;
  confidence: number;
  version: number;
  source: 'user_defined' | 'learned' | 'imported';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LearningEvent {
  id: string;
  at: string;
  kind: 'correction' | 'confirmed_workflow' | 'preference_stated' | 'rejection';
  /** Normalized key used to detect repeated patterns (§65). */
  key: string;
  previousBehavior?: string;
  correction?: string;
  context?: string;
  taskId?: string;
  projectId?: string;
  /** Becomes a skill candidate when count/confidence justify it. */
  occurrences: number;
  confidence: number;
  promotedSkillId?: string;
}
