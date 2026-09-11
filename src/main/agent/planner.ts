/**
 * Task classification + step planning — spec §8 steps 1-6 and §58 question
 * policy. Heuristics first (cheap, §55); the agent asks only when proceeding
 * would risk an important/destructive action under ambiguity.
 */

import type { AppMode } from '../../shared/types/capabilities.js';
import type { TaskClass } from '../../shared/types/task.js';

export interface AgentPlan {
  taskClass: TaskClass;
  /** Steps are guidance for the loop; the model decides tool order within them. */
  steps: { name: string; purpose: string }[];
  /** True when the request should ask a clarifying question instead of acting. */
  needsClarification: boolean;
  clarificationReason?: string;
}

const ACTION_VERBS =
  /(fix|repair|debug|create|make|add|write|edit|change|refactor|rename|move|delete|install|run|build|test|search|find|remember|clean|set up|setup|deploy|update|ergegne|änd|mach|bau|such|erstell|lösch|korrigier|reparier)/i;
const READONLY_HINTS = /(what|why|how does|explain|describe|summarize|explain|was ist|warum|erklär|beschreib|zeig mir)/i;
const PROJECT_HINTS = /(project|repo|code|build|test|error|crash|bug|deploy|funktion|projekt|fehler|absturz)/i;

/** §57: understand imperfect natural language — this stays intentionally simple. */
export function classifyTask(userText: string, mode: AppMode, hasProject: boolean, hasImages: boolean): TaskClass {
  const t = userText.toLowerCase();
  if (hasImages) return 'vision';
  if (/^(remember that|merk dir|don'?t forget|ab jetzt immer|always )/.test(t) || /remember (that|my|my preference)/.test(t))
    return 'informational';
  if (hasProject && /(fix|debug|crash|error|exception|stack trace|warum.*geht nicht|reparier|报错|异常)/.test(t)) return 'debugging';
  if (hasProject && /(refactor|add feature|implement|write.*test|optimi|schneller|performance|verbesser|funktion hinzufügen|code)/.test(t))
    return 'coding';
  if (hasProject && /(review|check.*change|lgtm|code review)/.test(t)) return 'code_review';
  if (/(find.*file|search.*folder|rename|move .*to|organize|delete .*old|sortier|aufräum|such.*datei|verschieb)/.test(t)) return 'file_ops';
  if (/(summariz|zusammenfass)/.test(t)) return 'summarization';
  if (/(extract|list all|count how many|extrahier)/.test(t)) return 'extraction';
  if (mode === 'CODING') return 'coding';
  if (mode === 'AGENT' && ACTION_VERBS.test(t)) return hasProject && PROJECT_HINTS.test(t) ? 'coding' : 'file_ops';
  if (mode === 'ASSISTANT' && ACTION_VERBS.test(t)) return 'file_ops';
  if (READONLY_HINTS.test(t) && !ACTION_VERBS.test(t)) return 'informational';
  return 'chat';
}

export function needsClarification(
  userText: string,
  taskClass: TaskClass,
  hasWritableRoots: boolean,
  permissionMode: 'SAFE' | 'BALANCED' | 'ADVANCED',
): { needed: boolean; reason?: string } {
  const t = userText.toLowerCase();
  // §58: destructive + ambiguous target => ask, never guess.
  if (/(delete|erase|remove all|wipe|entfern.*alle|lösch)/.test(t) && !/tmp|temp|cache|old\b/.test(t)) {
    return {
      needed: true,
      reason: 'The request involves deletion but the target is ambiguous. Confirm exactly what should be deleted before I act.',
    };
  }
  // actionable request but nothing writable -> informational explanation beats a dead end
  if (!hasWritableRoots && (taskClass === 'file_ops' || taskClass === 'coding' || taskClass === 'debugging')) {
    return {
      needed: false,
      reason: undefined,
    };
  }
  void permissionMode;
  return { needed: false };
}

export function buildPlan(taskClass: TaskClass, userText: string, hasProject: boolean): AgentPlan {
  const steps: AgentPlan['steps'] = [];
  switch (taskClass) {
    case 'debugging':
      steps.push(
        { name: 'collect error info', purpose: 'find the actual failure: logs, stack traces, the user quote' },
        { name: 'inspect relevant source', purpose: 'read the implicated files before touching anything' },
        { name: 'identify likely cause', purpose: 'smallest reasonable hypothesis' },
        { name: 'apply minimal change', purpose: 'checkpoint first, patch, not rewrite' },
        { name: 'verify', purpose: 'reproduce/verify: tests, build, or targeted run' },
      );
      break;
    case 'coding':
      steps.push(
        { name: 'understand project', purpose: 'read project overview and nearby code' },
        { name: 'plan change', purpose: 'constraints, files affected' },
        { name: 'edit with patches', purpose: 'precise find/replace edits after checkpoint' },
        { name: 'verify', purpose: 'typecheck/tests/build per project scripts' },
      );
      break;
    case 'file_ops':
      steps.push(
        { name: 'locate targets', purpose: 'list/search before modifying' },
        { name: 'checkpoint + modify', purpose: 'recoverable changes only' },
        { name: 'confirm results', purpose: 'verify files exist as expected' },
      );
      break;
    case 'code_review':
      steps.push(
        { name: 'read changed code', purpose: 'via git diff if available, else named files' },
        { name: 'assess', purpose: 'bugs, style, security' },
      );
      break;
    default:
      steps.push({ name: 'answer', purpose: 'use retrieved context; admit unknowns' });
  }
  void hasProject;
  void userText;
  return { taskClass, steps, needsClarification: false };
}
