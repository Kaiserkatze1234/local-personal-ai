/**
 * Agent core — spec §8. Controlled loop: understand -> classify -> plan ->
 * context -> capabilities -> tools -> permissions -> execute -> observe ->
 * verify -> recover/retry (bounded) -> update state -> memory candidates ->
 * report. Multi-step work is a Task; chat turns are the lightweight path.
 */

import { existsSync } from 'node:fs';
import type { AppMode } from '../../shared/types/capabilities.js';
import { newId, nowIso } from '../../shared/types/common.js';
import type { AppBus } from '../../shared/types/events.js';
import type { ChatMessage, GenerationRequest, ToolCallSpec } from '../../shared/types/models.js';
import type { TaskRecord } from '../../shared/types/task.js';
import type { ToolResult } from '../../shared/types/tools.js';
import { answerReserveCap } from '../../shared/util/limits.js';
import { fitMessagesToWindow } from '../../shared/util/messageFit.js';
import { estimateTokens } from '../../shared/util/text.js';
import type { CheckpointService } from '../checkpoints/checkpointService.js';
import type { ConfigService } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { SubLogger } from '../core/logger.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { PermissionService } from '../permissions/permissionService.js';
import type { ProjectService } from '../projects/projectService.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelRouter } from '../providers/router.js';
import { resolveScopedPath } from '../security/fsSafe.js';
import type { ConversationRepo, MessageRepo } from '../storage/repositories.js';
import type { TaskManager } from '../tasks/taskManager.js';
import type { ToolRegistry, ToolRunContext } from '../tools/registry.js';
import type { ContextEngine } from './contextEngine.js';
import { buildPlan, classifyTask, needsClarification } from './planner.js';
import type { VerificationEngine } from './verification.js';

const MAX_TOOL_ITERATIONS = 8;
const MAX_MODEL_RETRIES = 1; // §15 bounded retries, no infinite loops

export interface RunInput {
  userText: string;
  conversationId?: string;
  mode: AppMode;
  projectId?: string;
  images?: { mimeType: string; dataBase64: string }[];
  title?: string;
}

export interface RunOutcome {
  taskId: string;
  finalText: string;
  task: TaskRecord;
}

export class AgentCore {
  constructor(
    private providers: ProviderRegistry,
    private router: ModelRouter,
    private tasks: TaskManager,
    private tools: ToolRegistry,
    private permissions: PermissionService,
    private contextEngine: ContextEngine,
    private verification: VerificationEngine,
    private checkpoints: CheckpointService,
    private memory: MemoryService,
    private projects: ProjectService,
    private conversations: ConversationRepo,
    private messages: MessageRepo,
    private config: ConfigService,
    private bus: AppBus,
    private log: SubLogger,
    /** Hooks the conversation layer supplies so agent output appears in the chat. */
    private hooks: {
      onStreamDelta?: (conversationId: string, messageId: string, delta: string) => void;
      onMessageAppended?: (conversationId: string) => void;
    } = {},
  ) {}

  async run(input: RunInput): Promise<RunOutcome> {
    const cfg = this.config.get();
    const writableRoots = cfg.tools.allowedRoots;
    const taskClass = classifyTask(input.userText, input.mode, input.projectId !== undefined, (input.images?.length ?? 0) > 0);
    const clarification = needsClarification(input.userText, taskClass, writableRoots.length > 0, cfg.tools.permissionMode);

    const task = this.tasks.create({
      title: input.title ?? firstSentence(input.userText),
      userRequest: input.userText,
      taskClass,
      conversationId: input.conversationId,
      projectId: input.projectId,
    });

    this.tasks.transition(task.id, 'analyzing', {}, 'understand & plan');
    const plan = buildPlan(taskClass, input.userText, input.projectId !== undefined);

    if (clarification.needed && clarification.reason) {
      this.tasks.finish(task.id, 'completed', clarification.reason);
      const finalText = `Before I act: ${clarification.reason}`;
      this.appendAssistantMessage(input.conversationId, finalText);
      return { taskId: task.id, finalText, task: this.tasks.get(task.id) as TaskRecord };
    }

    const signal = this.tasks.begin(task.id);
    try {
      // ---- context (steps 4-5) ----
      const ctx = await this.contextEngine.build({
        conversationId: input.conversationId,
        userText: input.userText,
        taskClass,
        projectId: input.projectId,
        imageAttachments: input.images?.length ?? 0,
      });

      // ---- routing (step 5/6) ----
      const decision = this.router.select(taskClass === 'coding' || taskClass === 'debugging' ? 'coding' : 'chat', taskClass, {
        needsToolCalling: true,
        needsVision: (input.images?.length ?? 0) > 0,
        minContextTokens: Math.max(4096, estimateTokens(ctx.summary) + input.userText.length / 4),
      });
      const t = this.tasks.get(task.id) as TaskRecord;
      t.modelSelections.push({ role: decision.role, providerId: decision.providerId, modelId: decision.modelId, reason: decision.reason });
      this.tasks.transition(t.id, 'executing', { modelSelections: t.modelSelections }, 'execute');

      // ---- model<->tool loop (steps 7-10) ----
      const system = this.contextEngine.systemPrompt(taskClass, cfg.personality, cfg.general.language);
      const contextBlock = this.contextEngine.renderContextBlock(ctx);
      const history = this.loadHistory(input.conversationId, input.userText);
      const userMsg: ChatMessage = {
        id: newId('msg'),
        role: 'user',
        content:
          input.images && input.images.length > 0
            ? [
                { type: 'text', text: `${contextBlock ? `${contextBlock}\n\n` : ''}${input.userText}` },
                ...input.images.map((i) => ({ type: 'image' as const, mimeType: i.mimeType, dataBase64: i.dataBase64 })),
              ]
            : `${contextBlock ? `${contextBlock}\n\n` : ''}${input.userText}`,
        createdAt: nowIso(),
      };
      const chatMsgs: ChatMessage[] = [
        { role: 'system', content: [system, planBlock(plan)].filter(Boolean).join('\n\n') },
        ...history,
        userMsg,
      ];

      const assistantMsgId = newId('msg');
      let finalText = '';
      let iterations = 0;
      const writtenFiles: string[] = [];
      // Send-side window guard: the loop appends assistant/tool groups per
      // iteration; anything beyond the num_ctx actually requested would be
      // silently pruned by the provider (system prompt lost mid-task). Same
      // shared policy as ContextEngine/adapter — newest groups win, older fold
      // into a note, assistant+tool groups stay atomic (see shared/util/messageFit).
      const promptCap = answerReserveCap(cfg.ai.runtimeContextTokens);
      const fitForWindow = (): void => {
        const fit = fitMessagesToWindow(chatMsgs, promptCap);
        if (fit.folded > 0) {
          chatMsgs.length = 0;
          chatMsgs.push(...fit.messages);
          this.log.info(`agent loop: folded ${fit.folded} older messages to fit the ${promptCap}-token prompt window`);
        }
      };
      const { provider } = this.providers.chatFor(decision.modelId);
      const supportsTools = decision.model.capabilities.includes('tool_calling');

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        fitForWindow();
        const req: GenerationRequest = {
          modelId: decision.modelId,
          messages: chatMsgs,
          temperature: cfg.ai.temperature,
          tools: supportsTools ? this.tools.definitions() : undefined,
          signal,
        };

        const result = await this.generateWithRetry(provider.adapter, req, signal, task.id, input, assistantMsgId);
        if (result.error) throw AppError.provider(`Model failed: ${result.error}`);
        if (signal.aborted) throw new Error('cancelled');
        finalText = result.text || finalText;

        if (!supportsTools || result.toolCalls.length === 0) break;

        chatMsgs.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls, id: newId('msg') });
        await this.executeToolCalls(result.toolCalls, task.id, signal, writtenFiles, chatMsgs);
        if (signal.aborted) throw new Error('cancelled');
      }

      // ---- verification (step 10) + ONE bounded repair pass (§15) ----
      let verificationResult: import('../../shared/types/task.js').VerificationResult | undefined;
      const needsVerify = writtenFiles.length > 0 || taskClass === 'debugging' || taskClass === 'coding';
      const verifyPlan = (): import('./verification.js').VerificationPlan => {
        const proj = this.projects.list().find((p) => p.id === input.projectId);
        return input.projectId
          ? { kind: 'code_change', cwd: proj?.path ?? process.cwd(), commands: proj?.testCommands ?? [] }
          : { kind: 'file_written', path: this.resolveInScope(writtenFiles[0] ?? '', 'read') ?? writtenFiles[0] ?? '' };
      };
      if (needsVerify) {
        this.tasks.transition(task.id, 'verifying', {}, 'verify');
        verificationResult = await this.verification.verify(verifyPlan(), task.id);
        let attemptsLeft = 1; // bounded: no infinite retry loops (§15)
        while (verificationResult.attempted && !verificationResult.passed && supportsTools && attemptsLeft > 0 && !signal.aborted) {
          attemptsLeft--;
          finalText += `\n\n[verification] failed; one bounded repair attempt: ${verificationResult.details.slice(0, 300)}`;
          chatMsgs.push({
            id: newId('msg'),
            role: 'user',
            createdAt: nowIso(),
            content: `Verification failed after your changes:\n${verificationResult.details.slice(0, 1500)}\nInspect what is wrong, apply the smallest reasonable fix with the file tools, then briefly state what you changed.`,
          });
          fitForWindow();
          try {
            const repair = await this.generateWithRetry(
              provider.adapter,
              {
                modelId: decision.modelId,
                messages: chatMsgs,
                temperature: cfg.ai.temperature,
                tools: supportsTools ? this.tools.definitions() : undefined,
                signal,
              },
              signal,
              task.id,
              input,
              assistantMsgId,
            );
            if (repair.text) finalText += `\n\n[repair] ${repair.text}`;
            chatMsgs.push({ role: 'assistant', content: repair.text, toolCalls: repair.toolCalls, id: newId('msg') });
            if (repair.toolCalls.length > 0) await this.executeToolCalls(repair.toolCalls, task.id, signal, writtenFiles, chatMsgs);
            if (signal.aborted) break;
            verificationResult = await this.verification.verify(verifyPlan(), task.id);
          } catch (err) {
            finalText += `\n\n[repair] could not run: ${(err as Error).message}`;
            break;
          }
        }
        if (!verificationResult.attempted) {
          finalText += `\n\n[verification] not possible here: ${verificationResult.details}`;
        } else if (!verificationResult.passed) {
          finalText += `\n\n[verification] FAILED — changes may be incomplete: ${verificationResult.details.slice(0, 400)}`;
        } else {
          finalText += `\n\n[verification] passed: ${verificationResult.method}`;
        }
      }

      // ---- memory candidates (step 13) ----
      if (taskClass !== 'chat') {
        this.maybeRecordExperience(task.id, input.userText, finalText, taskClass, verificationResult?.passed === true);
      }

      const finished = this.tasks.finish(task.id, 'completed', summarize(finalText, writtenFiles), {
        verification: verificationResult,
      });
      this.appendAssistantMessage(input.conversationId, finalText);
      this.tasks.recordTool(task.id, 'chat_model');
      void finished;
      return { taskId: task.id, finalText, task: this.tasks.get(task.id) as TaskRecord };
    } catch (err) {
      const cancelled = signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      if (cancelled) {
        this.tasks.transition(task.id, 'cancelled', { summary: 'Stopped by user.' }, 'cancelled');
        this.bus.emit({ type: 'chat.cancelled', conversationId: input.conversationId ?? '' });
        throw new AppError('invalid_state', 'Task cancelled.', []);
      }
      const kind = err instanceof AppError ? err.kind : 'tool';
      this.tasks.recordError(task.id, kind, message);
      this.tasks.finish(task.id, 'failed', `Task failed: ${message}`);
      const finalText = `I could not complete this: ${message}`;
      this.appendAssistantMessage(input.conversationId, finalText);
      return { taskId: task.id, finalText, task: this.tasks.get(task.id) as TaskRecord };
    } finally {
      this.tasks.end(task.id);
      this.permissions.denyForTask(task.id);
    }
  }

  /** Plain chat: one generation, streamed, no task overhead beyond persistence. */
  async chatTurn(input: {
    conversationId: string;
    userText: string;
    images?: { mimeType: string; dataBase64: string }[];
    projectId?: string;
    signal?: AbortSignal;
  }): Promise<{ assistantMessageId: string; text: string }> {
    const cfg = this.config.get();
    const taskClass = (input.images?.length ?? 0) > 0 ? 'vision' : 'chat';
    const ctx = await this.contextEngine.build({
      conversationId: input.conversationId,
      userText: input.userText,
      taskClass,
      projectId: input.projectId,
    });
    let decision: import('../providers/router.js').RouteDecision;
    try {
      decision = this.router.select(taskClass === 'vision' ? 'vision' : 'chat', taskClass, {
        needsVision: taskClass === 'vision',
      });
    } catch (err) {
      // honest failure per §3.8: explain the missing capability
      const msg = err instanceof AppError ? err.message : 'No model available.';
      throw AppError.provider(msg);
    }
    const chatMsgs: ChatMessage[] = [
      {
        role: 'system',
        content: [
          this.contextEngine.systemPrompt(taskClass, cfg.personality, cfg.general.language),
          this.contextEngine.renderContextBlock(ctx),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...this.loadHistory(input.conversationId, input.userText),
      {
        id: newId('msg'),
        role: 'user',
        content:
          input.images && input.images.length > 0
            ? [
                { type: 'text', text: input.userText },
                ...input.images.map((i) => ({ type: 'image' as const, mimeType: i.mimeType, dataBase64: i.dataBase64 })),
              ]
            : input.userText,
        createdAt: nowIso(),
      },
    ];
    const assistantMessageId = newId('msg');
    const { provider } = this.providers.chatFor(decision.modelId);
    let text = '';
    const req: GenerationRequest = { modelId: decision.modelId, messages: chatMsgs, temperature: cfg.ai.temperature, signal: input.signal };
    if (provider.adapter.chat?.stream) {
      for await (const chunk of provider.adapter.chat.stream(req)) {
        text += chunk.textDelta;
        this.hooks.onStreamDelta?.(input.conversationId, assistantMessageId, chunk.textDelta);
      }
    } else {
      const r = await provider.adapter.chat!.generate(req);
      text = r.text;
    }
    this.messages.add(input.conversationId, { id: assistantMessageId, role: 'assistant', content: text, createdAt: nowIso() });
    this.hooks.onMessageAppended?.(input.conversationId);
    // explicit "remember that ..." in plain chat becomes a memory candidate
    if (/^(remember that|merk dir|don'?t forget)/i.test(input.userText.trim())) {
      try {
        const content = input.userText.trim().replace(/^(remember that|merk dir|don'?t forget[:,!]?)\s*/i, '');
        this.memory.add({ content, type: 'preference', importance: 0.7, source: 'user', autoConfirm: !cfg.memory.requireReview });
      } catch (err) {
        this.log.warn(`memory capture failed: ${(err as Error).message}`);
      }
    }
    return { assistantMessageId, text };
  }

  private async generateWithRetry(
    adapter: { chat?: { generate(req: GenerationRequest): Promise<import('../../shared/types/models.js').GenerationResult> } },
    req: GenerationRequest,
    signal: AbortSignal,
    taskId: string,
    input: RunInput,
    assistantMsgId: string,
  ): Promise<import('../../shared/types/models.js').GenerationResult> {
    if (!adapter.chat) throw AppError.provider('Provider lacks chat capability.');
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
      try {
        const result = await adapter.chat.generate(req);
        // mirror streamed-style UI updates even for non-stream generate
        if (result.text) this.hooks.onStreamDelta?.(input.conversationId ?? '', assistantMsgId, result.text);
        return result;
      } catch (err) {
        lastErr = err as Error;
        if (signal.aborted) break;
        this.tasks.recordError(taskId, 'provider', `attempt ${attempt + 1}: ${lastErr.message}`);
      }
    }
    throw lastErr ?? new Error('generation failed');
  }

  /** Prior turns (chat roles only); the just-stored current user text is excluded. */
  private loadHistory(conversationId: string | undefined, currentUserText: string): ChatMessage[] {
    if (!conversationId) return [];
    const msgs = this.messages.list(conversationId, 14).filter((m) => m.role === 'user' || m.role === 'assistant');
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string' && last.content.trim() === currentUserText.trim()) msgs.pop();
    return msgs.map(stripIds);
  }

  /** Runs model-requested tool calls with checkpoint-before-mutate, then feeds results back. */
  private async executeToolCalls(
    calls: ToolCallSpec[],
    taskId: string,
    signal: AbortSignal,
    writtenFiles: string[],
    chatMsgs: ChatMessage[],
  ): Promise<void> {
    for (const call of calls) {
      const mutatingNames = ['delete_path', 'patch_file', 'write_file', 'move_path'];
      if (mutatingNames.includes(call.name) && typeof call.args.path === 'string') {
        // risky modification -> checkpoint the target first (§37)
        const abs = this.resolveInScope(call.args.path, 'write');
        if (abs && existsSync(abs)) {
          const ck = await this.checkpoints.createForFiles(`auto before ${call.name}`, [abs], taskId).catch(() => null);
          if (ck) {
            this.tasks.recordCheckpoint(taskId, ck.id);
            this.bus.emit({ type: 'checkpoint.created', checkpointId: ck.id, taskId, files: ck.fileCount });
          }
        }
      }
      const toolCtx = this.makeToolCtx(taskId, signal);
      const toolResult: ToolResult = await this.tools.call(call.name, call.args, toolCtx);
      this.tasks.recordTool(taskId, call.name);
      if (
        (call.name === 'write_file' || call.name === 'patch_file' || call.name === 'make_dir') &&
        toolResult.ok &&
        typeof call.args.path === 'string'
      ) {
        writtenFiles.push(call.args.path);
        this.tasks.recordFile(taskId, call.args.path);
      }
      chatMsgs.push({
        role: 'tool',
        content: JSON.stringify(toModelSafe(toolResult)),
        toolCallId: call.id,
        name: call.name,
        id: newId('msg'),
      });
    }
  }

  private makeToolCtx(taskId: string, signal: AbortSignal): ToolRunContext {
    const cfg = this.config.get();
    return {
      taskId,
      signal,
      log: this.log,
      fsRoots: () => ({
        read: cfg.tools.readRoots.length > 0 ? cfg.tools.readRoots : cfg.tools.allowedRoots,
        write: cfg.tools.allowedRoots,
      }),
      cwd: () => this.projectCwd(),
    };
  }

  private projectCwd(): string | undefined {
    const ps = this.projects.list();
    return ps[0]?.path;
  }

  private resolveInScope(p: string, mode: 'read' | 'write'): string | null {
    if (!p) return null;
    try {
      const cfg = this.config.get();
      const roots =
        mode === 'read' ? (cfg.tools.readRoots.length > 0 ? cfg.tools.readRoots : cfg.tools.allowedRoots) : cfg.tools.allowedRoots;
      const r = resolveScopedPath(p, roots, this.projectCwd());
      return r.ok ? (r.path ?? null) : null;
    } catch {
      return null;
    }
  }

  private maybeRecordExperience(taskId: string, request: string, finalText: string, taskClass: string, verified: boolean): void {
    const cfg = this.config.get();
    if (!cfg.memory.enabled) return;
    if (!verified) return; // §66 only trust verified outcomes; corrections path handles failures
    try {
      const content = `Task [${taskClass}] "${request.slice(0, 100)}" completed${finalText.includes('[verification] passed') ? ' with verification' : ''}. Outcome: ${summarize(finalText, []).slice(0, 300)}`;
      this.memory.add({ content, type: 'episode', importance: 0.35, confidence: 0.55, source: 'agent', relatedTaskIds: [taskId] });
    } catch (err) {
      this.log.debug(`experience recording skipped: ${(err as Error).message}`);
    }
  }

  private appendAssistantMessage(conversationId: string | undefined, text: string): void {
    if (!conversationId) return;
    this.messages.add(conversationId, { id: newId('msg'), role: 'assistant', content: text, createdAt: nowIso() });
    this.conversations.touch(conversationId);
    this.hooks.onMessageAppended?.(conversationId);
  }
}

function stripIds(m: ChatMessage): ChatMessage {
  return {
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p) => p.type === 'text')
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join(' '),
  };
}

function planBlock(plan: { steps: { name: string; purpose: string }[] }): string {
  return `Planned approach (adapt as you learn, keep steps minimal):\n${plan.steps.map((s, i) => `${i + 1}. ${s.name} — ${s.purpose}`).join('\n')}`;
}

function firstSentence(t: string): string {
  const s = t.split(/[.!?\n]/)[0]?.trim() ?? t;
  return s.slice(0, 80);
}

function summarize(text: string, files: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const f = files.length > 0 ? ` Files: ${files.join(', ')}.` : '';
  return `${clean.slice(0, 240)}${clean.length > 240 ? '…' : ''}${f}`;
}

function toModelSafe(r: ToolResult): Omit<ToolResult, 'stdoutPreview' | 'stderrPreview'> & { data?: unknown } {
  const { stdoutPreview: _s, stderrPreview: _e, ...rest } = r;
  return rest;
}
