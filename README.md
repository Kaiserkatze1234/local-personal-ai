# Local Personal AI

A local-first personal AI agent for Windows: chat, real tool-backed task
execution, project coding with verification, memory that stays useful,
skills you can review — with your model of choice. No cloud account, no
telemetry, no hard dependency on any specific runtime model.

The governing document is [`docs/MASTER_SPECIFICATION.txt`](docs/MASTER_SPECIFICATION.txt).
How the code maps to it: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/PHASE_MAP.md`](docs/PHASE_MAP.md).

## What it does (short version)

- **Chat** with any locally served model (Ollama auto-detected, or any
  OpenAI-compatible endpoint via env) — streaming, cancellable, searchable history.
- **Agent/Coding modes** turn requests into Tasks: classify → plan → retrieve
  ranked context → route per role → call scoped tools (with permission
  confirmations) → observe → verify (typecheck/tests, honest "unverified"
  when impossible) → checkpointed file changes you can roll back.
- **Memory** that dedups, expires, stays reviewable (nothing stored silently
  unless you allow it), and is injected by relevance — not by similarity.
- **Learning** from confirmed corrections → skill candidates → your approval.
- **Vision / screen / overlay / proactive hints** when the machine can
  actually provide them; clear explanations when it cannot (never fake it).
- **Optional internet layer** (documentation lookup) — off by default, gated
  by both a settings kill-switch and the per-request permission.
- **German-first**: the AI answers in German by default (`general.language`,
  mirrors the user otherwise); whisper.cpp and OpenAI-compatible TTS speak and
  listen locally; screen recordings and PDF/DOCX documents are ingestable.
- **Windows desktop behaviour**: autostart (optional), start-hidden to tray,
  close-to-tray, tray menu, global hotkeys, λ app icon in window/tray/installer.
- **Extensions** with validated manifests (capabilities, permissions,
  dependencies) can contribute tools and file importers without core edits.
- **Dictation & speech**: push-to-talk hotkey fills the composer, 🔊 reads
  answers aloud; overlay, region screen capture and idle model unloading round
  out the desktop experience.

## Quick start (dev)

```bash
npm install
npm run dev          # vite + rebuilt main + electron
npm test             # 76 integration tests against the real core (no Electron needed)
npm run typecheck    # node + web projects
npm run lint         # biome
npm run build        # dist/main, dist/preload, dist/renderer
npm run dist         # electron-builder NSIS installer (run on Windows)
```

Headless exploration without Electron: the whole core is bootable from node —
see `tests/helpers.ts` for the minimal invocation.

## Layout

```
src/shared/     types, ipc contract, small utils — no runtime deps
src/main/       the application: core/, providers/, agent/, tools/, memory/,
                skills/, projects/, indexing/, checkpoints/, resources/,
                diagnostics/, promptAssistant/, proactive/, vision/,
                screen/, voice/, security/, storage/, tasks/, files/
src/preload/    contextBridge allowlist (§35)
src/renderer/   React UI: chat, tasks, projects, memory, skills,
                diagnostics, settings, wizard; separate overlay entry
tests/          vitest integration suite booting the real CoreApp
docs/           master spec + architecture + phase map
scripts/        esbuild bundler for main/preload (watch mode for dev)
```

## Security posture (what is real, not marketing)

- Renderer: contextIsolation on, nodeIntegration off, CSP; one IPC channel,
  allowlisted methods.
- All file tools resolve through a scope sandbox — empty allowlist means no
  filesystem access, period. Writes are atomic.
- Permission matrix per mode (SAFE/BALANCED/ADVANCED) with per-request
  allow/deny, session grants, and persistent grants you can revoke;
  dangerous operations force confirmation even in ADVANCED.
- Logs redact secrets (keys/bearer tokens).
- Screenshots are ephemeral unless you explicitly enable persistence.
- Uninstall: delete the data directory (`%APPDATA%/lpai` by default) —
  config.json + lpai.db + checkpoints are everything.

## Runtime models

The app is model-independent by design: providers advertise capabilities
(tool calling, vision, context size), role bindings route tasks to the
largest capable model (or smallest for lightweight work under pressure).
Recommended starting point on a mid-range Windows box: an 8B-class
tool-calling chat model + a small (1–3B) assistant model, via Ollama;
`qwen2.5-coder:7b` for coding work. Demo/mock provider exists for UI
testing and is always labeled as not real AI.

## Running on Windows

1. Install [Node.js 20+](https://nodejs.org) and (recommended) [Ollama](https://ollama.com) with a model, e.g. `ollama pull qwen2.5-coder:7b`.
2. Dev mode: `npm install` → `npm run dev` (Electron + Vite with hot reload).
3. Installer: `npm run dist` → `release/Local Personal AI-Setup-*.exe` (x64/ARM64) or the portable `.exe`.
4. First start walks you through provider detection, model choice, permissions and performance profile. Data lives in `%APPDATA%/lpai` — delete that folder for a full reset; nothing else is written.

### Start it by opening one thing

You do not need a separate habit of "launching the app". After installing (the NSIS setup,
never the portable exe, registers it):

- Right-click a `.txt/.md/.log/.json/.csv/.tsv/.html/.pdf/.docx` file → **Öffnen mit… → Local Personal AI**.
  The document is parsed and imported into your knowledge base, the chat window opens on top —
  ask about it right away. Re-opening the same path refreshes the entry instead of duplicating it.
- If the app is already running (or hidden in the tray), "Open with" feeds the *existing* window —
  no second instance; the window surfaces with an import notice.
- You can also **drag a file onto the window** anywhere — same import route.
- Double-click as *default* app: set it yourself per file via "Öffnen mit… → Immer diese App" —
  the installer deliberately never hijacks your default handlers.
- The portable `.exe` works for "open with" too: choose it once via "Andere Apps auf meinem
  Computer durchsuchen…" — Windows then launches it with the file path as argv, which the app
  consumes directly; no registry entry needed. (Drag & drop and the in-app import dialog work
  in every case.)
