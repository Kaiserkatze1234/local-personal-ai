/**
 * Bounded growth for multi-round tool loops (spec §29 fit rules — the same
 * policy as shared/util/limits). The agent loop appends assistant/tool turns
 * per iteration; sending an array that exceeds the num_ctx actually requested
 * lets the provider silently drop the LEADING prompt (system instructions,
 * early findings) instead of failing loudly. This keeps the send-side within
 * the window: system turn first, newest groups, everything older folded into
 * one compact note. Assistant-with-toolCalls + its role:'tool' results form an
 * ATOMIC group — splitting them produces requests strict providers reject.
 */
import type { ChatMessage } from '../types/models.js';
import { estimateTokens } from './text.js';

export const FOLD_PREFIX = '[Earlier conversation folded to fit the model context window';

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');

/** ~12 tokens overhead per toolCall envelope (ids, JSON structure). */
const estOf = (m: ChatMessage): number => estimateTokens(textOf(m)) + (m.toolCalls?.length ? 12 : 0);

interface Group {
  start: number;
  end: number;
  tokens: number;
}

function groups(messages: ChatMessage[]): Group[] {
  const out: Group[] = [];
  for (let i = 0; i < messages.length; ) {
    const m = messages[i] as ChatMessage;
    let end = i + 1;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      while (end < messages.length && (messages[end] as ChatMessage).role === 'tool') end++;
    }
    let tokens = 0;
    for (let k = i; k < end; k++) tokens += estOf(messages[k] as ChatMessage);
    out.push({ start: i, end, tokens });
    i = end;
  }
  return out;
}

export interface FitResult {
  messages: ChatMessage[];
  folded: number;
}

/** Idempotent: an already-fitting array comes back untouched (folded === 0). */
export function fitMessagesToWindow(messages: ChatMessage[], capTokens: number): FitResult {
  if (capTokens <= 0 || messages.length === 0) return { messages, folded: 0 };
  let total = 0;
  for (const m of messages) total += estOf(m);
  if (total <= capTokens) return { messages, folded: 0 };

  const hasSystem = (messages[0] as ChatMessage).role === 'system';
  const head = hasSystem ? messages.slice(0, 1) : [];
  const usedHead = head.reduce((s, m) => s + estOf(m), 0);
  const rest = hasSystem ? messages.slice(1) : messages;
  const gs = groups(rest);

  // the current user request (last bare user turn — carries the assembled context
  // from ContextEngine) is PINNED: the model must never lose what it was asked to do
  let anchorG = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i] as ChatMessage;
    if (m.role === 'user' && !m.toolCalls?.length) {
      const g = gs.findIndex((grp) => i >= grp.start && i < grp.end);
      if (g >= 0) anchorG = g;
      break;
    }
  }

  const kept = new Set<number>();
  let used = usedHead;
  if (anchorG >= 0) {
    kept.add(anchorG);
    used += (gs[anchorG] as Group).tokens;
  }
  // keep whole groups newest-first; the newest group ALWAYS stays (it is what the
  // model must act on next, even if it alone is oversized — extreme case)
  for (let g = gs.length - 1; g >= 0; g--) {
    if (kept.has(g)) continue;
    const grp = gs[g] as Group;
    if (g === gs.length - 1) {
      used += grp.tokens;
      kept.add(g);
      continue;
    }
    if (used + grp.tokens > capTokens) break;
    used += grp.tokens;
    kept.add(g);
  }

  const folded = gs.map((_g, i) => i).filter((i) => !kept.has(i));
  if (folded.length === 0) return { messages, folded: 0 }; // only an oversized pinned/last group can explain the overflow
  const droppedMsgs = folded.flatMap((i) => rest.slice((gs[i] as Group).start, (gs[i] as Group).end));
  const excerpt = droppedMsgs
    .slice(0, 3)
    .map((m) => `${m.role}: ${textOf(m).replace(/\s+/g, ' ').slice(0, 60)}`)
    .join(' | ');
  const note: ChatMessage = {
    role: 'user',
    content: `${FOLD_PREFIX} — ${droppedMsgs.length} messages): ${excerpt}]`,
  };
  const out: ChatMessage[] = [...head];
  let notePlaced = false;
  for (let g = 0; g < gs.length; g++) {
    const grp = gs[g] as Group;
    if (kept.has(g)) {
      out.push(...rest.slice(grp.start, grp.end));
    } else if (!notePlaced) {
      out.push(note);
      notePlaced = true;
    }
  }
  if (!notePlaced) out.push(note);
  return { messages: out, folded: droppedMsgs.length };
}
