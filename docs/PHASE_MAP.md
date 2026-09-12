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
| 9 — Multimodal | supported models analyze visual context | **done** (runtime-dependent) | vision routing, ephemeral + **region** capture (drag-select window), image attachments, **real PDF/DOCX importers** (text layer / document.xml — honest failure otherwise), **§22 recording pipeline now reachable from the UI** (🎬 → pick → adaptive frames → summary); ffmpeg/vision presence still probed, never assumed; pipeline E2E-validated with real ffmpeg binaries (7th pass) |
| 10 — Voice | local voice path with supported backend | **done** (backend-dependent) | role-bound STT/TTS + demo backends + **shipped local adapters: whisper.cpp HTTP (STT) and OpenAI-compatible /v1/audio/speech (TTS)**, auto-registered from Settings base URLs; dictation hotkey, speak-aloud with interruption (new utterance/dictation stops playback), voice selection + speed/volume passed to backend, STT language follows general.language |
| 11 — Prompt assistant | improve prompts without full-agent-per-keystroke | **done** | heuristic analysis (zero model calls), debounce client + throttle server, chips with insert/ignore, settings switch, optional small-model pass |
| 12 — Overlay | works without disturbing desktop use | **done** (needs Windows to feel) | frameless/transparent/always-on-top card; **global hotkey toggle re-registered on config change**; position/opacity settings; gaming mode = click-through display-only, normal mode = interactive with screen-ask box; destroy-on-hide = zero idle cost |
| 13 — Proactive | assist when strongly relevant, never annoying | **done** | `proactive/` rules on real events (build.failed, provider loss, job done), confidence gate, hourly budget, quiet hours, 3×ignore→auto-mute |
| 14 — Optimization | measure, then optimize actual bottlenecks | **done** (machine-specific numbers pending) | resource sampling + LOW_RESOURCE policy + generation-pauses-indexing + prefer-small routing + **§56 idle model unloading (tracked usage, provider unloadModel)** + batched file-index writes (one fsync per 500-row tx) + single-query conversation list (verified, not rewritten); latency/throughput numbers collectable on target hardware via `npm run bench` (harness shipped + regression-tested; numbers still to be reviewed) |
| 15 — Recovery & hardening | failures produce understandable recovery | **done** | corrupt-config→defaults+backup, db error surfaced in health, provider failure→failed task with recovery hints, boot→interrupted tasks `paused` w/ rerun/discard, malformed tool args tolerated, timeouts everywhere; **§15 bounded repair loop: failed verification feeds back into exactly ONE tool-enabled repair pass + re-verify, then honest reporting** |
| 16 — Installer | end user needs no source code | **done** (run `npm run dist` on Windows) | `electron-builder.yml`: NSIS **x64 + ARM64** + portable variant, custom install dir, start-menu/desktop shortcuts, app data preserved on uninstall, `deleteAppDataOnUninstall: false` (local-first); `build/installer.nsh` registers Explorer "Öffnen mit…" via `Applications\…\SupportedTypes` — deliberately not default-handler takeover; first-run wizard (provider detect→role binding→permissions→perf profile). Producing the actual `.exe` is a Windows-machine command |

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

## Fourth build pass — German-first UI + desktop completeness

- **German UI chrome (§47 language):** renderer strings flow through
  `shared/i18n.ts` (English-keyed dictionary, `de` default, graceful fallback).
  The AI reply language (system prompt) and the UI now follow the same setting.
- **Startup behavior (§47):** `autostart` (Windows login item), `startHidden`
  (window starts in tray), `closeToTray` (X hides instead of quitting) — with
  tray menu (Open / Overlay / Beenden), tray icon included in build output.
- **§42 completeness:** extensions can now also contribute **UI panels**
  (`ctx.addPanel`) and **providers** (`ctx.addModelProvider`, registered +
  refreshed live, removed on uninstall) — matching the spec's category list
  (providers, tools, importers, skills, UI panels, voice, vision).
- **§50/§52:** recent-log tail in the Diagnostics panel, "open log folder" /
  "open export location" reveals (honest in headless mode).
- **Windows icons:** λ icon generated at `build/icon.png|ico` (multi-size),
  wired into BrowserWindow, Tray, and the installer.

## Fifth build pass — start the app by opening one thing

- **Launch-with-file (Windows "Öffnen mit…" / double-click after choosing the
  app):** `main/launchFiles.ts` extracts real document paths from argv —
  exe path, Chromium switches and `electron .` dev noise are filtered, Win
  vs POSIX path semantics picked per argument (testable on any host).
  `index.ts` feeds them through `CoreApp.openFiles` after boot, queues
  pre-ready ones (incl. macOS `open-file`), and brings the window forward
  even when startHidden/closeToTray is set.
- **Already-running case:** `second-instance` forwards the new argv → same
  import route; plain relaunch still just focuses/restores the window.
- **Shared import route:** dialog, drag & drop and launch all run
  `CoreApp.importFilePath` — refresh-in-place on the same `source_path`
  (no duplicate docs), per-file `file.opened` event; renderer shows a German
  notice (Importiert/Aktualisiert + chunk count) and reloads the doc list
  (`knowledgeVersion` counter).
- **Drag & drop anywhere:** preload exposes `webUtils.getPathForFile`
  (the modern, contextIsolation-safe API); App.tsx shows a drop veil and
  imports what resolves to a disk path, honestly rejects data-only drops.
- **Installer side:** `build/installer.nsh` (electron-builder auto-include)
  registers `HK(CU|LM)\Software\Classes\Applications\<exe>` with
  `SupportedTypes` + open command — the app appears in "Öffnen mit…" for
  txt/md/markdown/log/json/csv/tsv/html/htm/pdf/docx (both cases, which is
  what SupportedTypes matching requires) and un-registers itself on
  uninstall. `fileAssociations` in the yml was deliberately NOT used: the
  shipped macro overwrites `.ext` default handlers, which would hijack the
  user's Notepad/browser defaults.

## Sixth build pass — Windows dev loop + desktop polish

- **Native ABI, solved honestly (the fresh-Windows-clone crash):** `npm install`
  produces a Node-ABI `better-sqlite3`; Electron refuses to load it
  (`NODE_MODULE_VERSION`). `scripts/prepare-native.mjs` (run automatically as
  `predev`, manually via `npm run native:fetch`) downloads the prebuilt
  Electron-ABI binding through better-sqlite3's own `prebuild-install`, caches it
  in `native/electron/` (gitignored) and restores `node_modules` byte-for-byte —
  so `npm test` (Node ABI) and `npm run dev` (Electron ABI) coexist.
  `storage/db.ts: resolveSqliteBinding` probes candidates (env override,
  app-local, resources) and loads the first that works; packaged builds need
  nothing (electron-builder `npmRebuild`). A real ABI mismatch now raises an
  actionable hint instead of a raw dlopen error. Verified here end-to-end:
  fetch cached `electron-v145` for Electron 41.7.1, node tests stayed green.
- **Window placement persistence** (`main/electron/windowState.ts`): saved on
  move/resize/maximize (debounced 600 ms) + flush on close, restored clamped —
  a position on an unplugged monitor is dropped so the window never opens
  off-screen (work-area aware, taskbar respected). Pure parse/snapshot core,
  5 unit tests.
- **Windows correctness polish:** AppUserModelID now set before any
  window/tray/notification exists (was set inside the window factory);
  userData pinned to `%APPDATA%\lpai` pre-ready so dev/packaged/portable share
  exactly the documented data dir; boot failures surface in a real error
  dialog instead of a silent double-click; native file dialogs are localized
  via the same i18n table as the chrome.

## Seventh build pass — real-binary validation + measurement tooling (user audit items 2 & 7)

- **§22 recording pipeline validated against REAL ffmpeg/ffprobe.**
  `tests/recording-ffmpeg.test.ts` generates an actual 6-second video
  (`lavfi testsrc`, mpeg4), then runs the production path: `status` gate →
  `probe` (640×480@25fps verified) → adaptive sampling plan (6 frames/1s, not
  150) → `extractFrames` asserting JPEG magic bytes + real sizes → `summarize`
  checking every frame's actual base64 reached the model seam and timestamps
  stitched into the summary — plus the honest failure path for garbage input
  with ffmpeg PRESENT. Auto-skips unless `npm i --no-save ffmpeg-static ffprobe-static`
  is installed (dev-only validation deps; CI stays green either way).
  **This caught a genuine production bug:** `extractFrames` never created its work
  directory — ffmpeg silently extracted zero frames on every real run (tests had
  been stubbing around it). Fixed, and analyzed frames are now deleted after
  each summary instead of leaking into tmp.
- **§14/§56 numbers are now one command.** `npm run bench` bundles the type-checked
  `src/main/diagnostics/bench.ts` and runs it headless against the user's LIVE
  config: provider health latency, raw generation with real usage-token
  tok/s, E2E `chat.send` + time-to-first-token (stream events), embeddings,
  memory/knowledge retrieval over the live DB, SQLite WAL insert throughput,
  CPU/RAM snapshot, and the §56 idle-unload round trip with Ollama
  `/api/ps` resident-MiB before/after — the "does unload actually free VRAM"
  proof. Report saved next to the logs (`<dataDir>/bench/report-*.md`).
  `--demo` = mock core/temp dir; harness regression-covered (`tests/bench.test.ts`).
- **Audit decisions recorded (this turn):** GUI computer control = explicit Phase 2,
  "don't start before stability" (user) — CHECKLIST §C now carries the phase label;
  voice polish and OCR stay conditional with the user's own assessments quoted;
  skill-editor UI polish stays non-blocking. Nothing new built for those.

## Eighth build pass — §24 voice settings take effect

Closed the last unchecked [code] sub-items in the checklist (spec's own §24
feature list, not new scope): `voice.speed`/`voice.volume` were stored but had
no audible path. Now `TtsModelContract` carries `appliesSpeed` (a backend that
synthesizes with speed itself — the Piper-style adapter — declares it, and
`voice.speak` reports back via `speedApplied` so the player never re-applies
it); `Audio.volume` is always applied client-side since no server consumes it.
The policy is pure and tested (`renderer/lib/playback.ts`: clamping, garbage
input → neutral). Interruption completed: sending a message stops in-flight TTS
(dictation and a new utterance already did). The "voice selection" checkbox
turned out to be stale — `voiceName` was already wired through the whole path.
4 tests in `tests/voice-playback.test.ts`; suite at 90.

## Ninth build pass — Level 4/5 validation with a real runtime

Testing philosophy taken literally: mocked suites prove plumbing, so this pass ran the real thing.
Installed a genuine Ollama v0.34.0 (CPU) with `qwen2.5:0.5b` + `nomic-embed-text`, then:

- **Real-provider tests** (`tests/ollama-live.test.ts`, opt-in via `LPAI_OLLAMA_URL`): health with
  real model count, discovery with `/api/show` context refinement, non-streaming + streaming
  generation with server-reported usage counters, cancellation mid-stream, embedding similarity
  sanity, and §56 unload verified via `/api/ps` before/after. 7/7 green against the real server,
  twice back-to-back after ordering hardening (the embedding test moved last: its nomic model swap
  was the only thing that could queue-block another check on a 2-core/2 GB machine).
- **This caught a genuine bug**: `OllamaAdapter.request()` overrode the caller's `AbortSignal` with
  its own timeout controller (`{...init, signal: ctrl.signal}`), so "stop generation" never reached
  HTTP — the model kept generating a full response after the user cancelled (wasting GPU time and
  blocking the next request on a single-slot server). Fixed with a chained abort in BOTH ollama and
  openaiCompat (openaiCompat had the inverse flaw: caller signal dropped the timeout). The
  cancellation test timed out for 180 s before the fix; it takes 2.3 s after.
- **Real bench numbers** here: 16.1 tok/s generation (2-core CPU), TTFT 3554 ms end-to-end through
  `chat.send`, 768-dim embeddings, and idle unload measured 462 MiB → 0 MiB resident. Same command
  on the RTX 3070 box is the hardware verdict.
- **Boot smoke mode** (`LPAI_SMOKE=1` in `src/main/index.ts`): window + renderer load + preload
  bridge + `app.info` IPC round-trip, `smoke-result.txt` + exit code — the Electron-binary boot
  itself cannot run in this sandbox (no X libraries, no root), so it is verifiable-on-Windows, not
  claimed-verified-here.
- **Packaging**: `electron-builder --win --dir` produced a valid win32 layout on Linux —
  `Local Personal AI.exe`, `app.asar` (10.5 MB), and the packaged `better_sqlite3.node` carries the
  MZ/PE header (real electron-win32 prebuilt swapped in). Side effect discovered: the rebuild edits
  `node_modules` in place and breaks the Node-ABI test binding → added `postdist` restore.
  NSIS/portable targets + install/uninstall on Windows stay §B.

## Tenth build pass — the app booted for real, and looked right

Priority 2 finally executed beyond "main process boots": this sandbox can run Electron after all —
system libs were missing, but rootless provisioning works: download Debian 13 `.deb`s for the
12-lib ldd closure (dpkg-deb -x into /tmp/pfx, delete the shipped libc/ld to avoid shadowing), plus
an **Xvfb patched at byte level** (single `/usr/bin\0` string → `/tmp/b1\0`, so it finds `xkbcomp`
in the prefix). Full recipe:

```bash
cd /tmp && curl -fsSL -o Packages.xz http://deb.debian.org/debian/dists/trixie/main/binary-amd64/Packages.xz
# resolve deps closure for: libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64
#   libcups2t64 libgtk-3-0t64 libxkbcommon0 libasound2t64 libxdamage1 xvfb (+closure)
# dpkg-deb -x each into /tmp/pfx; then:
LD_LIBRARY_PATH=/tmp/pfx/usr/lib/x86_64-linux-gnu PATH=/tmp/b1:$PATH \
  /tmp/pfx/Xvfb2 :99 -screen 0 1280x800x24 -xkbdir /tmp/pfx/usr/share/X11/xkb &
cd repo && LD_LIBRARY_PATH=/tmp/pfx/usr/lib/x86_64-linux-gnu DISPLAY=:99 LPAI_SMOKE=1 \
  node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage --disable-gpu .
```

Result: `SMOKE_OK ... renderer+ipc ok: app.info (411ms)` with SQLite booted, plus the smoke now
also saves `smoke-window.png` via `capturePage` — the first actual visual proof of the rendered UI.
That screenshot exposed a real German-first flaw: the first-run wizard's body paragraphs were
unwrapped raw English (only headings/bullets had `L()`). All wizard + first-screen chat strings are
now translated — 10 new dictionary entries plus 4 that already existed but had never been wrapped in
`L()` (deduplicated; the pre-existing wording won) — and a dictionary-coverage test
(`fourth-pass.test.ts`) fails if any visible key ever falls back to English. `npm run smoke` added as the one-command boot check everywhere (it is what
closes the Windows "does it start" item in §B in 20 seconds). Electron window-manager behavior
(tray, click-through overlay, DPI) still needs the Windows box; the *app stack* itself is now
boot-verified, not claimed.

## Eleventh pass (part 2) — Ollama runtime context bug (real Windows failure)

Reported on the target machine: `qwen3:4b` advertises 262144 context; OLLAMA_CONTEXT_LENGTH=8192
did not help; generation attempted a ~35.4 GB KV allocation; live tests died at first generation.
Audit (`src/main/providers/adapters/ollama.ts`) found the root cause and two cousins of the same
class — declared-but-never-transmitted request options, silently dropped by `JSON.stringify`:

1. **`options.num_ctx: undefined`** in `generate` (and ABSENT in `stream` — the path real chat
   turns use) → Ollama fell back to the model's Modelfile default (262144 for qwen3). Fixed: a
   single `resolveNumCtx()` decides every request — explicit `req.contextTokens` > config
   `ai.runtimeContextTokens` (NEW setting, default **4096**, editable in Settings → AI with an
   explanatory field) — and is clamped to `[512, hardwareContextCeiling()]` (4096/8192/16384/32768
   by installed RAM; a 16 GB laptop can never be talked into a 35 GB KV cache by model metadata).
   Model metadata's `contextLength` stays purely informational (router + discovery untouched).
2. **`maxTokens` never reached the server** (no `num_predict`) → the live cancellation test's
   "long story" looped for 11 MINUTES past the whole window (log: `context shift, n_discard=2045`,
   request ended only when TCP died). Wired for generate+stream; unset stays absent (server
   default), never 0.
3. **`refineContext` read only `llama.context_length`** inside a nested `model_info` — current
   Ollama returns a FLAT dict with family prefixes (`qwen3.context_length`). Generalized to both
   shapes (unit-tested both). Without this the advertised max was invisible (always fell to 4096).

Also noted, not a bug: `keepAliveSec` (§56 field) is honored only by the explicit unload path;
nothing sets it on normal requests by design (idle unload covers residency). Recorded in §C.

Proof (all re-run against a REAL ollama 0.34.0 + qwen2.5:0.5b with OLLAMA_CONTEXT_LENGTH=8192 set
to mirror the Windows config): live suite 8/8 in 19 s — captured exact wire bodies show `num_ctx
2048` (explicit test context, honored over the env default) and `num_ctx 4096` on the default path
while the model advertises 32768 (informational) — plus a new offline regression file
(`tests/ollama-context.test.ts`, 8 tests) proving a 262144-advertising model never receives a
262144 request, both /api/show shapes parse, clamps hold, and the config default is a LIVE getter
(Settings change applies next request, no re-registration).

## Notes for whoever continues

- Every "needs-hardware/partial" line is a **deployment** gap, not a missing
  abstraction: the seams (HostBindings, provider adapters, ffmpeg/vision
  status) are where the remaining pieces plug in without touching the core.
- The mock provider (`mock:demo-local-1`) is the test/demo runtime — it is
  labeled "not real AI" everywhere it can surface (label, echo prefix).
- Add a real GUI-automation tool later as *one more* `ToolDefinition` with
  its own permission id (§10) — the matrix already supports per-permission
  modes.
