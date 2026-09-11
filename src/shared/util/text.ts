/**
 * Shared text utilities used by context, memory and indexing.
 * Token counts are estimates (~4 chars/token) — spec §54 budgets work on
 * estimates; real counts are only needed by providers themselves.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}

/** Keep head and tail of large outputs (errors usually live there). */
export function truncateMiddle(text: string, keepChars = 4000): string {
  if (text.length <= keepChars * 2 + 40) return text;
  const omitted = text.length - keepChars * 2;
  return `${text.slice(0, keepChars)}\n…[${omitted} chars omitted]…\n${text.slice(-keepChars)}`;
}

export interface TextChunk {
  index: number;
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Line-aware chunking with small overlap — §12/§62 ("do not blindly embed
 * every byte"; chunks carry source line refs).
 */
export function chunkText(text: string, maxChars = 3200, overlapLines = 3): TextChunk[] {
  const lines = text.split('\n');
  if (lines.length === 0) return [];
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let size = 0;
  let startLine = 1;
  let idx = 0;
  const flush = (endLine: number): void => {
    if (current.length === 0) return;
    chunks.push({ index: idx++, text: current.join('\n'), startLine, endLine });
    const overlap = current.slice(Math.max(0, current.length - overlapLines));
    current = [...overlap];
    size = current.join('\n').length;
    startLine = Math.max(1, endLine - overlap.length + 1);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > maxChars) {
      // hard-split giant single lines
      for (let pos = 0; pos < line.length; pos += maxChars) {
        flush(i);
        current.push(line.slice(pos, pos + maxChars));
        size = maxChars;
        startLine = i + 1;
        flush(i + 1);
      }
      continue;
    }
    if (size + line.length + 1 > maxChars && current.length > 0) flush(i);
    current.push(line);
    size += line.length + 1;
  }
  flush(lines.length);
  return chunks;
}

/** Normalized token set — used by lexical scoring and dedup (§17). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-. ]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Cheap lexical relevance 0..1: token overlap weighted by rarity + exact phrase bonus. */
export function lexicalRelevance(query: string, doc: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const d = tokenize(doc);
  if (d.length === 0) return 0;
  const dset = new Set(d);
  let hits = 0;
  for (const t of new Set(q)) if (dset.has(t)) hits++;
  let score = hits / new Set(q).size;
  if (doc.toLowerCase().includes(query.toLowerCase().trim())) score = Math.min(1, score + 0.3);
  return score;
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
