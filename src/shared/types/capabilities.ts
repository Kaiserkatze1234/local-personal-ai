/**
 * Capability + mode vocabularies. Everything in the app that could be
 * "unsupported" is expressed here so we can honor §3.8 NO FAKE CAPABILITIES.
 */

export type ModelCapability =
  | 'text_generation'
  | 'streaming'
  | 'tool_calling'
  | 'structured_output'
  | 'vision'
  | 'audio_input'
  | 'audio_output'
  | 'embeddings';

export const ALL_MODEL_CAPABILITIES: ModelCapability[] = [
  'text_generation',
  'streaming',
  'tool_calling',
  'structured_output',
  'vision',
  'audio_input',
  'audio_output',
  'embeddings',
];

/** Roles the user can bind models to (spec §6/§7). */
export type ModelRole =
  | 'chat'
  | 'planning'
  | 'coding'
  | 'review'
  | 'vision'
  | 'embeddings'
  | 'compression'
  | 'prompt_assistant'
  | 'summarization'
  | 'stt'
  | 'tts';

export const ALL_MODEL_ROLES: ModelRole[] = [
  'chat',
  'planning',
  'coding',
  'review',
  'vision',
  'embeddings',
  'compression',
  'prompt_assistant',
  'summarization',
  'stt',
  'tts',
];

export type ResourceMode = 'LOW_RESOURCE' | 'BALANCED' | 'PERFORMANCE';
export type PermissionMode = 'SAFE' | 'BALANCED' | 'ADVANCED';

/** §50: every health-reportable component uses this vocabulary. */
export type HealthState = 'OK' | 'WARNING' | 'ERROR' | 'UNAVAILABLE';

/** Interaction modes from §2. UI selects one; agent behavior follows. */
export type AppMode = 'CHAT' | 'AGENT' | 'CODING' | 'ASSISTANT';
