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

## Quick start (dev)

```bash
npm install
npm run dev          # vite + rebuilt main + electron
npm test             # 43 integration tests against the real core (no Electron needed)
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
