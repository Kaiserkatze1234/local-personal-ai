# Phase Map — implementation status vs. spec §70 phases

Status legend: **done** = implemented and covered by `npm test`; **partial** =
core works, flagged gaps; **needs-hardware** = code present but requires a
Windows/desktop runtime or external service to exercise.

| Phase | Acceptance (spec) | Status | Where / gaps |
|---|---|---|---|
| 0 — Foundation | empty app starts and builds | **done** | tsconfigs, `build.mjs`, vite two-entry, biome, vitest; `npm run build` green here |
| 1 — Core shell | starts, persists settings, reports health | **done** | `core/config` (atomic+versioned), `storage/db` (WAL+migrations), `eventBus`, `tasks/`, `diagnostics/healthService` |
| 2 — Provider abstraction | select runtime model w/o touching agent code | **done** | registry+3 adapters+health+streaming+abort+`ModelRouter`; tests incl. Ollama via stub fetch |
| 3 — Basic chat | fully local conversation, streaming, cancel | **done** | `agentCore.chatTurn`, stream events, `chat.cancel`, FTS search; UI `ChatPanel` |
| 4 — Tool system | safely perform approved actions | **done** | `tools/` + `permissions/` + `fsSafe`; schema validation, danger escalation, timeouts, audit rows |
| 5 — Agent engine | multi-step task executes + reports verified results | **done** | `agent/` (plan→context→route→tools→observe→verify, bounded retry, cancel); E2E tests incl. cancel-while-awaiting-permission |
| 6 — Project/coding engine | inspect & modify a real project, verify changes | **done** | `projects/projectService` (detect, incremental index, brief), patch tool, `checkpoints/`, `verification` runs project test commands |
| 7 — Memory & knowledge | reuse past knowledge without loading all history | **done** | `memory/` (ranked retrieval, dedup, compression, candidates→review), `files/importers` + knowledge chunks, conversation FTS search |
| 8 — Skills & learning | repeated workflows become reusable skills | **done** | `skills/` (learning events, promotion threshold, user review, toggle/delete, auto-select); correction API recorded; skill UI minimal (prompt-dialog editor) |
| 9 — Multimodal | supported models analyze visual context | **done** (runtime-dependent) | vision role routing + ephemeral capture + image attachments + **region capture (rect passthrough, Electron nativeImage crop)**; recording pipeline needs ffmpeg on PATH (honest UNAVAILABLE otherwise); PDF/DOCX parsers intentionally not faked — importers report unavailable, but §42 extension importers can add them per user choice |
| 10 — Voice | local voice path with supported backend | **done** (backend-dependent) | role-bound STT/TTS via providers; `voice.transcribe`/`voice.speak` IPC; composer 🎤 dictation with **global push-to-talk hotkey** (press=start, press=stop; mic permission only while voice enabled) + 🔊 speak per answer; speed/volume/voice settings; demo STT/TTS in mock provider so the pipeline is exercisable end-to-end |
| 11 — Prompt assistant | improve prompts without full-agent-per-keystroke | **done** | heuristic analysis (zero model calls), debounce client + throttle server, chips with insert/ignore, settings switch, optional small-model pass |
| 12 — Overlay | works without disturbing desktop use | **needs-hardware** | `OverlayController` (frameless/transparent/always-on-top, click-through, destroy-on-hide), overlay entry app, task text pushed on updates; global hotkey registration not yet wired |
| 13 — Proactive | assist when strongly relevant, never annoying | **done** | `proactive/` rules on real events (build.failed, provider loss, job done), confidence gate, hourly budget, quiet hours, 3×ignore→auto-mute |
| 14 — Optimization | measure, then optimize actual bottlenecks | **done** (machine-specific numbers pending) | resource sampling + LOW_RESOURCE policy + generation-pauses-indexing + prefer-small routing + **§56 idle model unloading (tracked usage, provider unloadModel)** + batched file-index writes (one fsync per 500-row tx) + single-query conversation list (verified, not rewritten); latency/throughput numbers on target hardware still to be collected |
| 15 — Recovery & hardening | failures produce understandable recovery | **done** | corrupt-config→defaults+backup, db error surfaced in health, provider failure→failed task with recovery hints, boot→interrupted tasks `paused` w/ rerun/discard, malformed tool args tolerated, timeouts everywhere; **§15 bounded repair loop: failed verification feeds back into exactly ONE tool-enabled repair pass + re-verify, then honest reporting** |
| 16 — Installer | end user needs no source code | **done** (run `npm run dist` on Windows) | `electron-builder.yml`: NSIS **x64 + ARM64** + portable variant, custom install dir, start-menu/desktop shortcuts, app data preserved on uninstall, `deleteAppDataOnUninstall: false` (local-first); first-run wizard (provider detect→role binding→permissions→perf profile). Producing the actual `.exe` is a Windows-machine command |

## Second build pass additions

- **§49 Internet layer**: `tools/web.ts` (`http_get`, `web_search`) — behind a
  settings kill-switch *and* `network.access` permission; host allowlist; capped,
  html-stripped fetch. Core features never reference it.
- **§42 Extensions**: `extensions/extensionRegistry.ts` — manifest validation
  (id/name/version/capabilities/permissions/dependencies), activate/dispose
  lifecycle, contributed tools (namespaced, cannot shadow core tools, cannot
  use undeclared permissions) and importers; visible + removable in Settings.
- **§56 Idle unload**, **§21 region capture**, **§24 dictation UI**,
  **§23 overlay hotkey/modes**, **§15 bounded repair**, batched index writes.

## Notes for whoever continues

- Every "needs-hardware/partial" line is a **deployment** gap, not a missing
  abstraction: the seams (HostBindings, provider adapters, ffmpeg/vision
  status) are where the remaining pieces plug in without touching the core.
- The mock provider (`mock:demo-local-1`) is the test/demo runtime — it is
  labeled "not real AI" everywhere it can surface (label, echo prefix).
- Add a real GUI-automation tool later as *one more* `ToolDefinition` with
  its own permission id (§10) — the matrix already supports per-permission
  modes.
