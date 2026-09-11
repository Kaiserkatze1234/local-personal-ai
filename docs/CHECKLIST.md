# Remaining-Work Checklist

Derived from a live audit of this repo (git `0d4a6a7`, 52/52 tests, tree clean) against
`docs/MASTER_SPECIFICATION.txt`. Legend:
**[code]** = implementable and testable right now in this environment.
**[hw]** = code exists; needs Windows hardware / real services to validate or package.
**[polish]** = spec-conditional ("where practical/where supported") or explicitly deferred.

## A. Real code gaps — implementable now

- [ ] **[code] §42 — Load extensions from disk.** `extensions/extensionRegistry.ts`
  validates manifests and installs/activates/uninstalls, but extensions can currently only
  be installed programmatically (used by tests). Missing: boot-time scan of
  `<data>/extensions/<id>/` (`manifest.json` + `main.mjs` default-export activate fn),
  uninstall writing a `.disabled` marker so reboots don't resurrect it, and a Settings
  "open extensions folder" affordance. ~1 file + 1 boot call + tests.
- [ ] **[code] §22 — Wire recording analysis to the UI/IPC.** `screen/recordingAnalysis.ts`
  (probe → adaptive frame sampling → event detection → summary/Q&A, honest UNAVAILABLE
  without ffmpeg or a vision model) exists and is instantiated in `app.ts`, but there is
  **no `recording.*` entry in `api.ts` / `ipc.ts` / preload / any component** — it is not
  reachable from the renderer. Needs: `recording.analyze` IPC + file picker + result panel.
- [ ] **[code] §12 — Real PDF text extraction.** `files/importers.ts` currently returns
  `unavailableReason: 'PDF extraction not installed yet (Phase 9)'` (line ~106). Spec says
  "PDF **where supported**": a best-effort extractor (FlateDecode content streams,
  Tj/TJ text operators, no OCR) with honest failure when there is no text layer.
- [ ] **[code] §12 — Real DOCX extraction.** Stub with `unavailableReason` right after
  the PDF one. A dependency-free reader is feasible (zip local-file-header parse +
  `zlib.inflateRawSync` on `word/document.xml` + tag stripping) with honest failure paths.
- [ ] **[code] §24 — First real voice backend adapters.** Spec: "Possible local backends
  can be added through adapters" — slots, contracts and demo backends exist, no real
  adapter ships. Add `providers/adapters/voiceServers.ts`: whisper.cpp HTTP server
  (`GET /health`, `POST /inference` multipart → STT) and a Piper-style HTTP TTS, enabled via
  optional base-URL settings, auto-registered at boot. Testable against local stub servers.
- [ ] **[code] §24 — Voice feature items still missing** (spec's own list):
  - [ ] `speed`/`volume` settings exist and are stored, but are **not applied** anywhere —
        renderer should set `Audio.playbackRate` / `Audio.volume` when speaking.
  - [ ] **Interruption**: starting dictation or sending a new message should stop
        in-flight TTS audio.
  - [ ] **Voice selection**: no `voice` id field on the TTS request path/config.
  - [ ] Streaming speech output, wake interaction, VAD — "where supported/practical"
        (see section C; push-to-talk itself is done).
- [ ] **[code] §21 — Region-capture UX.** The backend rect passthrough is done
  (`screen.capture(rect?)` → `nativeImage.crop`), but nothing produces a rect: no
  drag-to-select or active-window capture in the UI. Backend + UI are the remaining half.
- [ ] **[code] Docs fix — stale PHASE_MAP row.** The `12 — Overlay` row still reads
  "global hotkey registration not yet wired" (assert-less replace missed it in pass 2);
  hotkeys are wired and verified. Same sweep: re-verify every status line gained an
  asserted update.

## B. Needs a Windows box / real environment (no code gap)

- [ ] **[hw] §16 — Produce the installer:** `npm run dist` on Windows; add a real
  `build/icon.ico` (yml comment says it falls back to the Electron icon); smoke-test
  NSIS x64 + ARM64 + portable, data-dir persistence, uninstall keeping app data.
- [ ] **[hw] §23/§24 — Desktop feel checks:** overlay hotkey conflicts, click-through in
  games (low-level `forward:true` behavior), DWM per-monitor scaling at 125–250 %,
  `MediaRecorder` device defaults, global-shortcut while other apps hold focus.
- [ ] **[hw] §9/§22 — Recording analysis with real ffmpeg + a vision model** (Ollama
  `llava`/`qwen2.5-vl`), including the "import recording" path end-to-end.
- [ ] **[hw] §14/§56 — Measurement pass:** collect latency/throughput numbers, verify
  idle-unload actually frees VRAM with Ollama resident models (code + tests exist; the
  numbers were the stated purpose of that phase).
- [ ] **[hw] §40/§41 — Resource pressure behaviour** with real generations (pause/resume
  of indexing under load is unit-tested only).

## C. Explicitly deferred / conditional (documented, not faked)

- [ ] **[polish] §10 — GUI/computer actions** beyond file/command tools (deliberately
  unbuilt per ARCHITECTURE note; would need its own safety model).
- [ ] **[polish] §24 — wake word, VAD, streaming TTS playback** (spec conditions these on
  practicality/supported backends).
- [ ] **[polish] §12 — OCR for image-only PDFs** (needs an external engine; failure today
  is honest).
- [ ] **[polish] §18/§19 — fuller skill editor UI** (today: prompt-dialog level editing;
  review/toggle/delete exist).
- [ ] **[polish] Settings cleanup:** `voice.sttModel`/`ttsModel` config fields coexist with
  the `stt`/`tts` role bindings — unify to one path.

## Not gaps (verified recently, listed so they don't get re-audited)

- Internet layer §49, extension manifest/permission validation §42 (in-process),
  bounded repair loop §15, idle model unload §56, PTT hotkey plumbing §24, overlay
  modes/opacity/positions §23/§46, installer config contents §16, batched index writes
  §55 — all implemented and covered by the 52-test suite.
