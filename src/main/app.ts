/**
 * Core application container. Deliberately Electron-free: everything here is
 * bootable in tests (headless) and inside the Electron main process. Platform
 * surfaces (windows, notifications, dialogs, screen capture) arrive via
 * `HostBindings`.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, DeepPartial, LogLevel } from '../shared/types/config.js';
import type { AppEvent } from '../shared/types/events.js';
import { AgentCore } from './agent/agentCore.js';
import { ContextEngine } from './agent/contextEngine.js';
import { VerificationEngine } from './agent/verification.js';
import { CheckpointService } from './checkpoints/checkpointService.js';
import { ConfigService } from './core/config.js';
import { EventBus } from './core/eventBus.js';
import { type LogEntry, Logger } from './core/logger.js';
import { HealthService } from './diagnostics/healthService.js';
import { ExtensionRegistry } from './extensions/extensionRegistry.js';
import { BackgroundJobQueue } from './indexing/backgroundQueue.js';
import { GlobalFileIndex } from './indexing/globalFileIndex.js';
import { MemoryService } from './memory/memoryService.js';
import { PermissionService } from './permissions/permissionService.js';
import { ProactiveService } from './proactive/proactiveService.js';
import { ProjectService } from './projects/projectService.js';
import { PromptAssistant } from './promptAssistant/promptAssistant.js';
import { MockProvider } from './providers/adapters/mock.js';
import { OllamaAdapter } from './providers/adapters/ollama.js';
import { OpenAiCompatAdapter } from './providers/adapters/openaiCompat.js';
import { PiperHttpAdapter, WhisperHttpAdapter } from './providers/adapters/voiceServers.js';
import { ModelRoleService } from './providers/modelRegistry.js';
import { ProviderRegistry } from './providers/registry.js';
import { ModelRouter } from './providers/router.js';
import { ResourceManager } from './resources/resourceManager.js';
import { RecordingAnalysisService } from './screen/recordingAnalysis.js';
import { SkillService } from './skills/skillService.js';
import { SqlStore } from './storage/db.js';
import {
  CheckpointRepo,
  ConversationRepo,
  FileIndexRepo,
  KnowledgeRepo,
  LearningEventRepo,
  MemoryRepo,
  MessageRepo,
  PermissionGrantRepo,
  ProjectRepo,
  RoleAssignmentRepo,
  SkillRepo,
  TaskRepo,
  ToolRunRepo,
} from './storage/repositories.js';
import { TaskManager } from './tasks/taskManager.js';
import { isDangerousCommand, registerCommandTools } from './tools/commands.js';
import { registerFilesystemTools } from './tools/filesystem.js';
import { ToolRegistry } from './tools/registry.js';
import { registerSystemTools } from './tools/system.js';
import { registerWebTools } from './tools/web.js';
import type { ScreenSource } from './vision/visionService.js';
import { VisionService } from './vision/visionService.js';
import { VoiceService } from './voice/voiceService.js';

export interface HostBindings {
  /** Electron app name for notification etc.; informational. */
  hostName?: string;
  notify?: (title: string, body: string) => void;
  /** Renderer delivery (IPC send). */
  sendToUi?: (event: AppEvent) => void;
  /** Screen capture source provided by the Electron host (Phase 9/21). */
  screenSource?: ScreenSource;
  /** Pick a directory (dialog) — for project/workspace selection. */
  pickDirectory?: () => Promise<string | null>;
  /** Pick a file (dialog) — for knowledge import / recording analysis. */
  pickFile?: (filter?: string) => Promise<string | null>;
  /** Desktop overlay window controls (Electron host, Phase 12). */
  overlayShow?: () => void;
  overlayHide?: () => void;
  /** Region picker: shows a fullscreen selection window, resolves with the chosen rect. */
  pickRegion?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Delivers the region window's result (via api 'region.submit') back to the host. */
  onRegionResult?: (rect: { x: number; y: number; width: number; height: number } | null) => void;
}

export interface BootOptions {
  dataDir: string;
  host?: HostBindings;
  /** Test seams: override/extend provider adapters and disable timers. */
  adapters?: 'default' | 'mock-only' | (() => void);
  timers?: boolean;
}

export class CoreApp {
  readonly bus = new EventBus<AppEvent>();
  readonly log: Logger;
  readonly config: ConfigService;
  readonly store: SqlStore;
  readonly tasks: TaskManager;
  readonly providers: ProviderRegistry;
  readonly roles: ModelRoleService;
  readonly router: ModelRouter;
  readonly permissions: PermissionService;
  readonly tools: ToolRegistry;
  readonly memory: MemoryService;
  readonly skills: SkillService;
  readonly checkpoints: CheckpointService;
  readonly projects: ProjectService;
  readonly jobs: BackgroundJobQueue;
  readonly fileIndex: GlobalFileIndex;
  readonly resources: ResourceManager;
  readonly health: HealthService;
  readonly promptAssistant: PromptAssistant;
  readonly proactive: ProactiveService;
  readonly extensions: ExtensionRegistry;
  extensionsDir: string = '';
  readonly vision: VisionService;
  readonly recordings: RecordingAnalysisService;
  readonly voice: VoiceService;
  readonly agent: AgentCore;
  readonly convos: ConversationRepo;
  readonly messages: MessageRepo;
  readonly knowledge: KnowledgeRepo;

  private disposed = false;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  readonly host: HostBindings;

  constructor(readonly opts: BootOptions) {
    this.host = opts.host ?? {};
    mkdirSync(opts.dataDir, { recursive: true });
    this.log = new Logger({
      level: 'info',
      dir: opts.dataDir,
      onLog: (e: LogEntry) => {
        this.bus.emit({ type: 'log.entry', level: e.level, subsystem: e.subsystem, message: e.message });
      },
    });
    const sub = (name: string) => this.log.child(name);

    this.config = new ConfigService(opts.dataDir);
    this.log.setLevel(this.config.get().diagnostics.logLevel as LogLevel);

    this.store = new SqlStore(join(opts.dataDir, 'lpai.db'));
    const taskRepo = new TaskRepo(this.store);
    this.convos = new ConversationRepo(this.store);
    this.messages = new MessageRepo(this.store);
    const memoryRepo = new MemoryRepo(this.store);
    const skillRepo = new SkillRepo(this.store);
    const learningRepo = new LearningEventRepo(this.store);
    const grantRepo = new PermissionGrantRepo(this.store);
    const ckptRepo = new CheckpointRepo(this.store);
    const projectRepo = new ProjectRepo(this.store);
    const fileIndexRepo = new FileIndexRepo(this.store);
    const toolRunRepo = new ToolRunRepo(this.store);
    this.knowledge = new KnowledgeRepo(this.store);
    const roleRepo = new RoleAssignmentRepo(this.store);

    // bus -> host (Electron forwards to all windows)
    this.bus.onAny((e) => this.host.sendToUi?.(e));

    this.providers = new ProviderRegistry(this.store, sub('providers'));
    if (opts.adapters !== 'mock-only') {
      this.providers.register(new OllamaAdapter(), { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
      const remoteUrl = process.env.LPAI_OPENAI_BASE_URL;
      if (remoteUrl)
        this.providers.register(
          new OpenAiCompatAdapter({
            baseUrl: remoteUrl,
            apiKey: process.env.LPAI_OPENAI_KEY,
            id: 'openai_compat',
            label: 'OpenAI-compatible (env-configured)',
          }),
          { kind: 'openai_compat', baseUrl: remoteUrl },
        );
    }
    this.providers.register(new MockProvider({ id: 'mock', label: 'Demo model (built-in, not real AI)' }), { kind: 'mock' });

    this.roles = new ModelRoleService(roleRepo, this.providers);
    this.jobs = new BackgroundJobQueue(this.bus, sub('jobs'));
    this.jobs.setConcurrency(this.config.get().performance.backgroundConcurrency);
    this.resources = new ResourceManager(this.config, this.bus, sub('resources'), this.jobs);
    this.router = new ModelRouter(this.providers, this.roles, this.config);

    this.permissions = new PermissionService(this.config, grantRepo, this.bus, sub('permissions'));
    this.tools = new ToolRegistry(this.permissions, toolRunRepo, this.bus, sub('tools'), 10 * 60_000, (name, input) =>
      name === 'run_command' ? { dangerous: isDangerousCommand(String(input.command ?? '')) } : {},
    );
    registerFilesystemTools(this.tools);
    registerCommandTools(this.tools, {
      commandTimeoutSec: () => this.config.get().tools.commandTimeoutSec,
      onCommandFinished: (info) => {
        // §41/§27: build failure feeds the proactive service via a typed event
        if (info.exitCode !== 0 && /(build|test|make|tsc|vite|npm run|cargo|pytest)/i.test(info.command)) {
          const proj = this.projects.list().find((p) => info.cwd.startsWith(p.path));
          this.bus.emit({ type: 'build.failed', projectId: proj?.id, command: info.command, detail: `exit code ${info.exitCode}` });
        }
      },
    });
    registerSystemTools(this.tools, {
      health: () => this.health,
      memory: () => this.memory,
      knowledge: () => this.knowledge,
      fileIndex: () => fileIndexRepo,
      resources: () => this.resources,
    });
    // always registered; each tool gates itself on Settings → Internet (§49)
    registerWebTools(this.tools, this.config);
    this.extensions = new ExtensionRegistry(this.tools, this.permissions, sub('ext'));
    this.extensionsDir = join(opts.dataDir, 'extensions');

    this.memory = new MemoryService(memoryRepo, this.config, this.bus, sub('memory'));
    this.skills = new SkillService(skillRepo, learningRepo, sub('skills'));
    this.checkpoints = new CheckpointService(opts.dataDir, ckptRepo, sub('checkpoints'));
    this.projects = new ProjectService(projectRepo, sub('projects'), this.jobs);
    this.fileIndex = new GlobalFileIndex(fileIndexRepo, this.config, this.jobs, sub('fileindex'), this.bus);

    this.tasks = new TaskManager(taskRepo, this.bus, sub('tasks'), (id) => this.permissions.denyForTask(id));
    this.verification = new VerificationEngine(sub('verify'));
    this.vision = new VisionService(this.router, this.providers, this.config, opts.dataDir, sub('vision'), this.host.screenSource);
    this.contextEngine = new ContextEngine(
      this.memory,
      this.skills,
      this.projects,
      this.convos,
      this.messages,
      this.config,
      sub('context'),
      () => this.vision.describeLastScreenForContext(),
    );
    this.voice = new VoiceService(this.providers, this.roles, this.config);
    this.promptAssistant = new PromptAssistant(this.config, this.projects, sub('prompt'), this.router, this.providers);
    this.proactive = new ProactiveService(this.bus, this.config, sub('proactive'), { notify: (t, b) => this.host.notify?.(t, b) });
    this.recordings = new RecordingAnalysisService(this.vision, sub('recording'));
    this.agent = new AgentCore(
      this.providers,
      this.router,
      this.tasks,
      this.tools,
      this.permissions,
      this.contextEngine,
      this.verification,
      this.checkpoints,
      this.memory,
      this.projects,
      this.convos,
      this.messages,
      this.config,
      this.bus,
      sub('agent'),
      {
        onStreamDelta: (cid, mid, delta) => this.bus.emit({ type: 'chat.stream', conversationId: cid, messageId: mid, delta }),
        onMessageAppended: (cid) => this.bus.emit({ type: 'chat.message_added', conversationId: cid }),
      },
    );
    this.health = new HealthService({
      providers: this.providers,
      resources: this.resources,
      config: this.config,
      permissions: this.permissions,
      store: this.store,
      dataDir: opts.dataDir,
      log: sub('health'),
      logger: this.log,
      extraComponents: () => [this.voice.status(), this.vision.status()],
    });
  }

  // exposed for tests + settings previews; assigned in ctor above
  readonly contextEngine!: ContextEngine;
  readonly verification!: VerificationEngine;

  async boot(): Promise<void> {
    const log = this.log.child('boot');
    log.info('booting core services');
    // §51: surface interrupted work before anything else
    const recoverable = this.tasks.markInterruptedOnBoot();

    // §24: optional local voice backends, registered only when the user configures them
    const voiceCfg = this.config.get().voice;
    if (voiceCfg.sttBaseUrl)
      this.providers.register(new WhisperHttpAdapter(voiceCfg.sttBaseUrl), { kind: 'voice-stt', baseUrl: voiceCfg.sttBaseUrl });
    if (voiceCfg.ttsBaseUrl)
      this.providers.register(new PiperHttpAdapter(voiceCfg.ttsBaseUrl), { kind: 'voice-tts', baseUrl: voiceCfg.ttsBaseUrl });

    // §42: activate any extensions dropped into <data>/extensions (best-effort, never blocks boot)
    void this.extensions.loadFromDirectory(this.extensionsDir).then((r) => {
      if (r.loaded.length > 0) log.info(`extensions loaded: ${r.loaded.join(', ')}`);
      for (const e of r.errors) log.warn(`extension "${e.id}" failed to load: ${e.error}`);
    });
    if (recoverable.length > 0) log.info(`${recoverable.length} task(s) recovered into 'paused' for user decision`);

    await this.providers.refreshAll();
    this.roles.autoAssign();
    if (this.config.get().indexing.enabled) this.fileIndex.sync();
    if (this.opts.timers !== false) {
      this.resources.start();
      this.proactive.start();
      this.maintenanceTimer = setInterval(() => {
        try {
          if (this.config.get().memory.enabled) this.memory.compress();
        } catch (err) {
          log.warn(`memory maintenance failed: ${(err as Error).message}`);
        }
        try {
          // §56: don't park idle models in RAM/VRAM when the provider can unload
          const m = this.config.get().performance.modelIdleUnloadMinutes;
          if (m > 0) void this.providers.unloadIdle(m).then((u) => u.length > 0 && log.info(`unloaded idle model(s): ${u.join(', ')}`));
        } catch {
          /* provider offline — nothing resident anyway */
        }
      }, 10 * 60_000);
      this.maintenanceTimer.unref?.();
    }
    log.info('core ready');
  }

  getConfig(): Readonly<AppConfig> {
    return this.config.get();
  }

  patchConfig(p: DeepPartial<AppConfig>): Readonly<AppConfig> {
    const next = this.config.patch(p as object as DeepPartial<AppConfig>);
    // side effects of settings changes
    this.log.setLevel(next.diagnostics.logLevel);
    this.jobs.setConcurrency(next.performance.backgroundConcurrency);
    void this.providers.refreshProvider('ollama').catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.proactive.stop();
    this.resources.stop();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.config.dispose();
    this.store.close();
  }
}
