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
| 9 — Multimodal | supported models analyze visual context | **partial** | vision role routing + ephemeral capture + image attachments **done**; `desktopCapturer` wiring done (needs Electron run); recording pipeline needs ffmpeg on PATH (honest UNAVAILABLE otherwise); PDF/DOCX parsers intentionally not faked — importers report unavailable |
| 10 — Voice | local voice path with supported backend | **partial** | role-bound STT/TTS contracts, honest unavailable reporting, push-to-talk capture in composer; concrete whisper.cpp/TTS adapter not shipped (provider slot is where it goes) |
| 11 — Prompt assistant | improve prompts without full-agent-per-keystroke | **done** | heuristic analysis (zero model calls), debounce client + throttle server, chips with insert/ignore, settings switch, optional small-model pass |
| 12 — Overlay | works without disturbing desktop use | **needs-hardware** | `OverlayController` (frameless/transparent/always-on-top, click-through, destroy-on-hide), overlay entry app, task text pushed on updates; global hotkey registration not yet wired |
| 13 — Proactive | assist when strongly relevant, never annoying | **done** | `proactive/` rules on real events (build.failed, provider loss, job done), confidence gate, hourly budget, quiet hours, 3×ignore→auto-mute |
| 14 — Optimization | measure, then optimize actual bottlenecks | **partial** | resource sampling + LOW_RESOURCE policy + generation-pauses-indexing + prefer-small routing implemented; the *measurement* pass (numbers on target hardware) is a Windows-machine task — deliberately not simulated |
| 15 — Recovery & hardening | failures produce understandable recovery | **done** | corrupt-config→defaults+backup, db error surfaced in health, provider failure→failed task with recovery hints, boot→interrupted tasks `paused` w/ rerun/discard, malformed tool args tolerated, timeouts everywhere; more soak-testing welcome |
| 16 — Installer | end user needs no source code | **partial** | `electron-builder.yml` (NSIS win x64/ARM64) + first-run wizard (provider detect→role binding→permissions→perf profile) implemented; actually *producing* an `.exe` requires running the build on Windows — not attempted blind here |

## Notes for whoever continues

- Every "needs-hardware/partial" line is a **deployment** gap, not a missing
  abstraction: the seams (HostBindings, provider adapters, ffmpeg/vision
  status) are where the remaining pieces plug in without touching the core.
- The mock provider (`mock:demo-local-1`) is the test/demo runtime — it is
  labeled "not real AI" everywhere it can surface (label, echo prefix).
- Add a real GUI-automation tool later as *one more* `ToolDefinition` with
  its own permission id (§10) — the matrix already supports per-permission
  modes.
