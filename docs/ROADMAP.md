# Roadmap

Each phase ends with the Definition of Done in ENGINEERING_STANDARDS.md.

## Phase 1 — Foundation (current)

- [x] pnpm monorepo, strict TS, ESLint, Prettier, Vitest
- [x] Tauri 2 + React shell, dark theme, sidebar, mock dashboard, live API status
- [x] Fastify API: `/health`, `/api/version`, env validation, JSON logs, CORS, host guard, graceful shutdown
- [x] SQLite + Drizzle schema for the 11 core tables, migrations, WAL/FKs
- [x] Python worker skeleton with `/health` and compute-backend detection
- [ ] CI (GitHub Actions), Gitleaks, Renovate/Dependabot, Trivy
- [ ] Playwright E2E smoke test
- [ ] PowerShell worker script for Windows; first Windows verification

## Phase 2 — Local service lifecycle and data

- API as a Tauri sidecar (started/stopped with the app), per-session API token
- Service manager in Settings: start/stop worker and Ollama, show resource use
- Channels CRUD, real dashboard queries, diagnostics screen, log rotation
- DB backup/restore

## Phase 3 — Durable job engine

- Persisted job runner with leases, retries (backoff + jitter), cancellation, startup recovery
- Resource scheduler: concurrency limits, model lifecycle manager, memory budgets

## Phase 4 — Content pipeline

- Ollama-backed ideation and scripting
- TTS (Kokoro/Piper), whisper.cpp transcription
- Media library with rights tracking and import validation

## Phase 5 — Rendering

- FFmpeg pipelines (streamed, chunked), Remotion composition, caption animation, thumbnails

## Phase 6 — Publishing

- YouTube OAuth (tokens in OS keychain), upload as private by default, scheduling, explicit human approval before anything public
