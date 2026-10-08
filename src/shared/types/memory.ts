/** Memory system — spec §16/§17/§64. */

export type MemoryType = 'preference' | 'fact' | 'workflow' | 'project_knowledge' | 'episode' | 'correction';

export type MemoryStatus = 'candidate' | 'stored' | 'obsolete';

export type MemorySource = 'user' | 'agent' | 'import' | 'correction';

export interface MemoryScope {
  kind: 'global' | 'project';
  projectId?: string;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  content: string;
  /** 0..1 — retrieval weight (§64). */
  importance: number;
  confidence: number;
  source: MemorySource;
  scope: MemoryScope;
  relatedTaskIds: string[];
  /** When this entry compresses others, the merged-away ids. */
  supersedesIds: string[];
  createdAt: string;
  lastUsedAt?: string;
  usedCount: number;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  score: number;
  /** Lexical / semantic / recency — for transparency. */
  matchedBy: string;
}
