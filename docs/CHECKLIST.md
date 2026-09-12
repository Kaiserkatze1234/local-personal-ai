# Remaining-Work Checklist

Derived from a live audit of this repo (git `0d4a6a7`, 52/52 tests, tree clean) against
`docs/MASTER_SPECIFICATION.txt`. Legend:
**[code]** = implementable and testable right now in this environment.
**[hw]** = code exists; needs Windows hardware / real services to validate or package.
**[polish]** = spec-conditional ("where practical/where supported") or explicitly deferred.

## A. Real code gaps — implementable now

- [x] **[code] §42 — Load extensions from disk.** `extensions/extensionRegistry.ts`
  validates manifests and installs/activates/uninstalls, but extensions can currently only
  be installed programmatically (used by tests). Missing: boot-time scan of
  `<data>/extensions/<id>/` (`manifest.json` + `main.mjs` default-export activate fn),
  uninstall writing a `.disabled` marker so reboots don't resurrect it, and a Settings
  "open extensions folder" affordance. ~1 file + 1 boot call + tests.
- [x] **[code] §22 — Wire recording analysis to the UI/IPC.** `screen/recordingAnalysis.ts`
  (probe → adaptive frame sampling → event detection → summary/Q&A, honest UNAVAILABLE
  without ffmpeg or a vision model) exists and is instantiated in `app.ts`, but there is
  **no `recording.*` entry in `api.ts` / `ipc.ts` / preload / any component** — it is not
  reachable from the renderer. Needs: `recording.analyze` IPC + file picker + result panel.
- [x] **[code] §12 — Real PDF text extraction.** `files/importers.ts` currently returns
  `unavailableReason: 'PDF extraction not installed yet (Phase 9)'` (line ~106). Spec says
  "PDF **where supported**": a best-effort extractor (FlateDecode content streams,
  Tj/TJ text operators, no OCR) with honest failure when there is no text layer.
- [x] **[code] §12 — Real DOCX extraction.** Stub with `unavailableReason` right after
  the PDF one. A dependency-free reader is feasible (zip local-file-header parse +
  `zlib.inflateRawSync` on `word/document.xml` + tag stripping) with honest failure paths.
- [x] **[code] §24 — First real voice backend adapters.** Spec: "Possible local backends
  can be added through adapters" — slots, contracts and demo backends exist, no real
  adapter ships. Add `providers/adapters/voiceServers.ts`: whisper.cpp HTTP server
  (`GET /health`, `POST /inference` multipart → STT) and a Piper-style HTTP TTS, enabled via
  optional base-URL settings, auto-registered at boot. Testable against local stub servers.
- [x] **[code] Eleventh pass (part 2) — Ollama runtime context fix (real Windows failure):** every
  `/api/chat` now sends an explicit bounded `options.num_ctx` (request override > config
  `ai.runtimeContextTokens`, default 4096, clamped to a hardware ceiling) — model-advertised
  maxima (qwen3:4b = 262144 → ~35.4 GB KV) can never reach the request; `maxTokens` finally
  travels as `num_predict` (the cancel-test story had looped 11 min past the window without it);
  `refineContext` parses current flat + legacy nested `/api/show` shapes (metadata-only).
  Regression coverage: `tests/ollama-context.test.ts` (offline, 8) + a captured-num_ctx assertion
  in the live suite. Details in PHASE_MAP.
- [x] **[code] Ninth pass — Level 4 validation against a real Ollama** (`tests/ollama-live.test.ts`,
  opt-in `LPAI_OLLAMA_URL`; 7/7 green against a real v0.34.0 server + `qwen2.5:0.5b` +
  `nomic-embed-text`). It caught and fixed a real cancellation bug (caller `AbortSignal` overridden
  by the adapter's own timeout controller in `ollama.ts`; both providers now chain both signals).
  Plus: `LPAI_SMOKE=1` boot validation in `src/main/index.ts` (window→preload→IPC→exit code +
  `smoke-result.txt`), `electron-builder --win --dir` verified on Linux (win32 exe + asar + PE-format
  electron-ABI sqlite binding), and a `postdist` hook restoring the Node-ABI binding that the
  in-place rebuild clobbers. Live `npm run bench` here: 16.1 tok/s on sandbox CPU, unload
  462 MiB → 0 MiB proven via `/api/ps`.
- [x] **[code] §24 — Voice feature items still missing** (spec's own list):
  - [x] `speed`/`volume` now take effect: the renderer sets `Audio.volume` (never consumed
        server-side) and `Audio.playbackRate` only when the bound backend did NOT synthesize with
        speed — `voice.speak` returns `speedApplied` (Piper-style adapters declare
        `tts.appliesSpeed`; pure logic in `src/renderer/lib/playback.ts`, tested in
        `tests/voice-playback.test.ts`). No double-application: 1.5x stays 1.5x.
  - [x] **Interruption**: starting dictation and starting a new utterance already stopped
        in-flight TTS; sending a new message now does too (`stopSpeech()` in `onSend`).
  - [x] **Voice selection** was already wired end-to-end (`voice.voiceName` config → Settings →
        Voice field → `TtsRequest.voice` → adapter body); the open checkbox was stale.
  - [ ] Streaming speech output, wake interaction, VAD — "where supported/practical"
        (see section C; push-to-talk itself is done).
- [x] **[code] §21 — Region-capture UX.** The backend rect passthrough is done
  (`screen.capture(rect?)` → `nativeImage.crop`), but nothing produces a rect: no
  drag-to-select or active-window capture in the UI. Backend + UI are the remaining half.
- [x] **[code] Seventh pass — real-binary validation + measurement tooling (user-audit items 2 and 7).**
  Recording pipeline now verified against REAL ffmpeg/ffprobe (`tests/recording-ffmpeg.test.ts`: generated
  video → probe → adaptive sampling → real JPEG extraction → per-frame vision seam → stitched summary;
  auto-skips unless `npm i --no-save ffmpeg-static ffprobe-static` is present). That validation caught and
  fixed two production bugs: `extractFrames` never created its work dir (real-world: zero frames, always)
  and extracted frames leaked in tmp. §14/§56 numbers became a command: `npm run bench`
  (`src/main/diagnostics/bench.ts`, harness covered by `tests/bench.test.ts`).
- [x] **[code] Docs fix — stale PHASE_MAP row.** The `12 — Overlay` row still reads
  "global hotkey registration not yet wired" (assert-less replace missed it in pass 2);
  hotkeys are wired and verified. Same sweep: re-verify every status line gained an
  asserted update.
- [x] **[code] Start the app by opening one thing (fifth pass).** Launch-with-file from
  Explorer ("Öffnen mit…", double-click once chosen) via argv + `second-instance` +
  macOS `open-file` → `CoreApp.openFiles`; shared `importFilePath` route with
  refresh-in-place and `file.opened` events; drag & drop through
  `webUtils.getPathForFile`; non-hijacking `build/installer.nsh` registration.
  Covered by `tests/open-file.test.ts` (76/76 overall). The NSIS registry behavior itself
  is in §B (needs Windows to verify).
- [x] **[code] Fresh-Windows dev loop (sixth pass).** `npm install && npm run dev` used to crash at
  startup with `NODE_MODULE_VERSION` (Node-ABI better-sqlite3 vs Electron ABI). Now: `predev` →
  `scripts/prepare-native.mjs` fetches the matching prebuilt into `native/electron/` (cached;
  `node_modules` untouched so `npm test` keeps working — verified end-to-end here: `electron-v145`
  for Electron 41.7.1, tests green after fetch), `resolveSqliteBinding` probes candidates at boot,
  and a real mismatch raises a fix-it hint. Plus: window placement persistence with
  off-screen/monitor-unplug guard, AppUserModelID before first window, `%APPDATA%\lpai` pinned for
  dev+packaged, boot failures shown in an error dialog, localized native dialogs. 84/84 overall.

## B. Needs a Windows box / real environment (no code gap)

- [ ] **[hw] Windows dev-loop verification:** on a fresh clone run `npm install && npm run dev` —
  `predev` must fetch `better-sqlite3-v*-electron-v145-win32-x64.tar.gz` (verify the sha matches the
  app's load, no AV/proxy surprises), window reopens at its last position across restarts and after
  moving between differently scaled monitors (off-screen guard), and boot problems show the error
  dialog with the actual reason. The app stack itself (window → renderer → preload → IPC → SQLite)
  is boot-verified headless on Linux with the screenshot showing the rendered UI — so on Windows,
  `npm run smoke` should return `SMOKE_OK` + a `smoke-window.png` in minutes; what remains
  Windows-specific is only what the smoke exit code cannot see (tray, overlay click-through, DPI,
  autostart registration).
- [ ] **[hw] Level 4 on the target box:** with Ollama installed on the RTX 3070, run
  `tests/ollama-live.test.ts` (README "Verify a real install") and `npm run bench` — expect real
  tok/s/TTFT on GPU and unload numbers reflecting VRAM, then review `release` artifacts from
  `npm run dist` (NSIS + portable; the `--dir` layout itself is already verified).

- [ ] **[hw] §16 — Produce the installer:** `npm run dist` on Windows (icons are
  committed: `build/icon.ico` multi-size + `icon.png`; `build/installer.nsh` carries the
  "Öffnen mit…" registration). Smoke-test on a real machine: NSIS x64 + ARM64 + portable,
  app appears in the Explorer "Open with" list for the supported extensions *without*
  changing default handlers, "Open with → Local Personal AI" launches (or surfaces) the
  window and shows the import notice, uninstall removes the `Applications\<exe>` key and
  keeps the data dir.
- [ ] **[hw] §23/§24 — Desktop feel checks:** overlay hotkey conflicts, click-through in
  games (low-level `forward:true` behavior), DWM per-monitor scaling at 125–250 %,
  `MediaRecorder` device defaults, global-shortcut while other apps hold focus.
- [ ] **[hw] §9/§22 — Recording analysis with a real vision model.** The full pipeline is validated with
  real binaries in tests (see §A seventh pass); what remains is QUALITY of summaries with a real vision model
  (Ollama `llava`/`qwen2.5-vl`) over your actual desktop recordings — trigger it with the 🎬 button, then also
  check frame scaling on your display configuration.
- [ ] **[hw] §14/§56 — Measurement pass on the target machine:** now one command — `npm run bench`
  (app closed, live config). It times provider health, raw generation latency + tok/s from real usage
  counters, an E2E chat turn incl. time-to-first-token, embeddings, memory/knowledge retrieval over the live
  DB, SQLite WAL insert throughput, a CPU/RAM snapshot, and the §56 idle-unload round trip with Ollama
  `/api/ps` resident-MiB before/after (the VRAM proof). Report: `%APPDATA%\lpai\bench\report-*.md`.
  `npm run bench -- --demo` sanity-checks the harness itself. Review the numbers, then decide what to optimize.
- [ ] **[hw] §40/§41 — Resource pressure behaviour** with real generations (pause/resume
  of indexing under load is unit-tested only).

## C. Explicitly deferred / conditional (documented, not faked)

- [ ] **[phase2] §10 — GUI computer-control actions** ("open VS Code", "click this button",
  "go to this site", "fill that field"). USER DECISION 2026-09-12: **Phase 2 — do not start
  before the rest of the app is proven stable.** It needs a stronger permission/safety model
  than today's per-mutation permission+audit; scope it as its own design pass when the time comes.
- [ ] **[polish] §24 — wake word, VAD, streaming TTS playback, more advanced voice interaction,
  better voice selection, additional voice controls.** User assessment: "not a fundamental
  blocker" — basic local voice is architecturally supported (whisper/Piper HTTP adapters + demo
  backends). Spec conditions these on practicality/supported backends.
- [ ] **[polish] §12 — OCR for image-only PDFs** (needs an external engine; failure today is
  honest). User assessment: "wouldn't make OCR a priority right now."
- [ ] **[polish] §18/§19 — fuller skill editor UI** (today: prompt-dialog level editing;
  review/toggle/delete exist).
- [ ] **[polish] Settings cleanup:** `voice.sttModel`/`ttsModel` config fields coexist with
        the `stt`/`tts` role bindings — unify to one path.
- [ ] **[polish] `keepAliveSec` is a request-contract field used only by the explicit unload
        path (keep_alive 0); normal requests let Ollama's server default govern residency, and
        §56 idle unload is the intended control. If finer per-model pinning is ever wanted, wire
        the field at the router — nothing else needs to change.

## Not gaps (verified recently, listed so they don't get re-audited)

- Internet layer §49, extension manifest/permission validation §42 (in-process),
  bounded repair loop §15, idle model unload §56, PTT hotkey plumbing §24, overlay
  modes/opacity/positions §23/§46, installer config contents §16, batched index writes
  §55 — all implemented and covered by the test suite.
