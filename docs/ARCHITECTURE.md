# Architecture — Local Personal AI

Source of truth: `docs/MASTER_SPECIFICATION.txt` (the spec this implements).
This document maps the spec onto the actual code. Numbers (§) refer to spec sections.

## Process model

```
┌──────────────────────────── Electron ────────────────────────────┐
│  main process                       renderer (Chromium)          │
│  ┌─────────────────────────┐        ┌──────────────────────────┐ │
│  │ src/main/index.ts        │        │ src/renderer/ (React 19) │ │
│  │  · windows, tray-grade   │  IPC   │  · panels, chat, dialogs │ │
│  │    host bindings           ──────▶│  · NO logic, projections │ │
│  │  · OverlayController     │ invoke │    of core state         │ │
│  │  · desktopCapturer       │ events │                          │ │
│  └───────────┬──────────────┘        └──────────────────────────┘ │
│              │ typed facade (Api)                                  │
│  ┌───────────▼───────────────────────────────────────────────┐    │
│  │ CoreApp (src/main/app.ts) — headless, testable, no         │    │
│  │ Electron imports. Everything real lives below this line.  │    │
│  └───────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
        preload (contextBridge, allowlisted methods only, §35)
```

Vitest boots `CoreApp` directly with a temp `dataDir` and the mock provider —
the same code path Electron uses (see `tests/helpers.ts`).

## Layering rules (spec §3.3)

1. **Capabilities never import UI.** All cross-cutting contact goes through
   the typed `InvokeContract` (`src/shared/types/ipc.ts`) implemented by
   `src/main/api.ts`.
2. **The model is a dependency, not an identity** (§4/§6): `ProviderRegistry`
   + adapters (`ollama`, `openai_compat`, `mock`) expose a uniform
   `chat.generate/stream`, `embeddings.embed`, optional `stt/tts`. Routing by
   *role* (`ModelRoleService`, `ModelRouter`), never by a hard-coded model.
3. **Honest unavailability** (§3.8): anything not installed/reachable reports
   `UNAVAILABLE` with recovery steps (voice, vision, PDF/DOCX extraction,
   screen on non-Electron hosts). Never faked.

## Module map

| Area | Path | Spec |
|---|---|---|
| Event bus | `main/core/eventBus.ts`, `AppBus` structural type in `shared/types/events.ts` | §30 |
| Config (atomic write, versioned, debounced flush) | `main/core/config.ts` | §47 |
| Logger (redaction, rotate) | `main/core/logger.ts` | §35/§48 |
| SQLite (WAL, user_version migrations, FTS5 + LIKE fallback) | `main/storage/db.ts` | §33/§34 |
| Repositories (13) | `main/storage/repositories.ts` | §33 |
| Provider registry/health | `main/providers/registry.ts` | §5/§53 |
| Role bindings + auto-assign | `main/providers/modelRegistry.ts` | §6/§7 |
| Task-class routing with recovery messages | `main/providers/router.ts` | §55/§56 |
| Adapters: ollama / openai-compat / mock | `main/providers/adapters/` | §5 |
| Task state machine (events double-write rows + bus) | `main/tasks/taskManager.ts` | §8/§9/§51 |
| Permission matrix, session/persistent grants, danger escalation | `main/permissions/permissionService.ts` | §10/§11 |
| Tool registry: schema validation → permission → bounded exec → audit | `main/tools/registry.ts` | §10/§36/§39 |
| File tools (scoped, atomic, binary-safe, patch w/ match counts) | `main/tools/filesystem.ts` | §11/§12 |
| Command tool (danger scan, tree-kill timeout) | `main/tools/commands.ts` | §36 |
| System tools (health/memory/knowledge/index/resources) | `main/tools/system.ts` | §49 |
| Web tools (off by default; kill-switch + `network.access`) | `main/tools/web.ts` | §49 |
| Extension registry (manifests, deps, contributed tools/importers) | `main/extensions/extensionRegistry.ts` | §42 |
| Disk extension loader (`manifest.json` + `main.mjs`, `.disabled` markers) | `main/extensions/extensionRegistry.ts` | §42 |
| PDF/DOCX best-effort parsers (no deps, honest failure) | `main/files/parsePdf.ts`, `parseDocx.ts` | §12 |
| whisper.cpp / local-TTS HTTP adapters | `main/providers/adapters/voiceServers.ts` | §24 |
| Path sandbox | `main/security/fsSafe.ts` | §11/§35 |
| Agent loop (14 controlled steps, bounded retries, checkpoint-before-mutate) | `main/agent/agentCore.ts` | §8/§14/§15 |
| Classification + plan + clarification policy | `main/agent/planner.ts` | §8/§57/§58 |
| Context engine (ranked, budgeted, source-referenced) | `main/agent/contextEngine.ts` | §29/§30/§54/§63 |
| Verification (never fakes a pass) | `main/agent/verification.ts` | §38 |
| Bounded verify → repair → re-verify loop (one pass) | `main/agent/agentCore.ts` | §15 |
| Memory (dedup, candidates→stored, ranked retrieval, compression) | `main/memory/memoryService.ts` | §16/§17/§64/§66 |
| Skills + learning events (promote only after threshold + review) | `main/skills/skillService.ts` | §18/§19/§65 |
| Projects (detect, incremental index, brief, ranked files) | `main/projects/projectService.ts` | §13/§54 |
| Ingestion adapters (md/txt/json/csv/html/code; pdf/docx honest) | `main/files/importers.ts` | §12/§62 |
| "Open with" launch: argv → file paths (per-arg Win/POSIX semantics, pure) | `main/launchFiles.ts` | §47/§62 |
| Installer "Open with" registration — Applications\...\SupportedTypes, no default-handler hijack | `build/installer.nsh` | §16 |
| Global metadata file index (opt-in roots only) | `main/indexing/globalFileIndex.ts` | §31 |
| Background queue (priorities, pause under pressure/generation) | `main/indexing/backgroundQueue.ts` | §40/§41/§55 |
| Checkpoints (manifest+hashes, restore is itself checkpointed) | `main/checkpoints/checkpointService.ts` | §37 |
| Resource manager (CPU/RAM sampling, auto LOW_RESOURCE, GPU via provider probe) | `main/resources/resourceManager.ts` | §40/§56 |
| Health/self-tests/diagnostics export | `main/diagnostics/healthService.ts` | §50/§53 |
| Prompt assistant (heuristic-first, optional debounced small-model pass) | `main/promptAssistant/` | §20/§45 |
| Proactive (rule-based, confidence gate, rate limit, ignore→mute) | `main/proactive/proactiveService.ts` | §27 |
| Vision (capability-routed; ephemeral captures) | `main/vision/visionService.ts` | §21/§25 |
| Recording analysis (ffmpeg probe, adaptive frame sampling) | `main/screen/recordingAnalysis.ts` | §22 |
| Voice (role-bound STT/TTS, honest when unbound) | `main/voice/voiceService.ts` | §24 |
| Electron host: window, capture, overlay, dialogs | `main/index.ts`, `main/electron/` | §42/§46 |
| Window placement persistence (off-screen/monitor-unplug guard) | `main/electron/windowState.ts` | §43/§47 |
| Runtime-correct SQLite binding (Node ABI tests vs Electron ABI dev+dist, verified prebuild cache) | `storage/db.ts` + `scripts/rebuild-native.mjs` + `native/` + `scripts/afterPack.cjs` | §16/§33 |
| Preload allowlist bridge | `src/preload/index.ts` | §35 |
| Renderer (React + zustand; thin projections) | `src/renderer/` | §43/§44 |

## Deliberate deviations from the letter of the spec

- `permission_grants` table name (spec §33 calls the concept "permissions").
- Knowledge base lives in `knowledge_documents/chunks` (same db) rather than a
  second store — §61 keeps it logically separate from memory, which it is.
- Input validation uses a small JSON-Schema subset validator
  (`shared/util/jsonSchema.ts`) instead of pulling in a dependency — enough
  for tool args (RULE 6), swappable later.
- GUI automation beyond file/command tools (§10 "computer actions") is not
  implemented; no phantom "automation" API was faked for it.

## Data directory

`LPAI_DATA_DIR` env wins (Electron main falls back to `userData/lpai`).
Contains: `lpai.db`, `config.json`, `logs/app.log`, `checkpoints/`, `screens/`,
`diagnostics/`. Nothing outside it is ever written without an explicit tool
grant.

## Second-pass behaviours worth knowing

- **Internet (§49):** `http_get`/`web_search` are always registered but
  self-gate on `Settings → Internet`; enabling the layer still does not bypass
  the `network.access` permission decision. Host allowlist + response-size cap
  + html stripping are enforced in the tool, not the prompt.
- **Extensions (§42):** modules provide a manifest (id, name, version,
  capabilities, permissions, dependencies); activation is validated, dependency
  checked, and reversible; contributed tools are namespaced and may not use
  permissions their manifest didn't declare; uninstall disposes and revokes
  session grants.
- **Overlay (§23/§46):** global hotkey (re-registered on config change);
  position/opacity from settings; `lowResourceMode` = click-through,
  display-only, never takes focus (gaming-friendly); normal mode exposes an
  "ask about my screen" box that runs through the same chat pipeline.
- **Voice (§24):** dictation hotkey toggles MediaRecorder capture (press=start,
  press=stop; `globalShortcut` has no key-up); mic permission is only granted
  while voice is enabled; 🔊 speak per assistant message; demo STT/TTS exist in
  the mock provider so the path is testable without hardware.
- **Region capture (§21):** `screen.capture` accepts an optional rect, cropped
  via `nativeImage` in the Electron source; thumbnail-space coordinates (1920-wide).
- **Idle unload (§56):** every chat/embedding use stamps a timestamp; a
  maintenance timer asks providers to unload models idle beyond
  `performance.modelIdleUnloadMinutes` (0 = off; Ollama `keep_alive:0`, mock records calls).

## Language behaviour

`general.language` (default `de`) is a first-class part of the system prompt —
the model answers in German unless the user writes another language, code stays
untranslated. STT inherits the same language tag; TTS voice selection via
`voice.voiceName`. Set to `off` to disable the instruction entirely.
