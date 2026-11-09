# Roadmap

Each phase ends with the Definition of Done in ENGINEERING_STANDARDS.md and a final summary in [PHASE_SUMMARIES.md](PHASE_SUMMARIES.md).

## Phase 1 — Foundation (done)

- [x] pnpm monorepo, strict TS, ESLint, Prettier, Vitest
- [x] Tauri 2 + React shell, dark theme, sidebar, mock dashboard, live API status
- [x] Fastify API: `/health`, `/api/version`, env validation, JSON logs, CORS, host guard, graceful shutdown
- [x] SQLite + Drizzle schema for the 11 core tables, migrations, WAL/FKs
- [x] Python worker skeleton with `/health` and compute-backend detection
- [x] CI (GitHub Actions), Gitleaks, Dependabot, Trivy — delivered in Phase 2
- [x] Playwright E2E — delivered in Phase 2 (browser + mocked IPC)
- [ ] PowerShell worker script for Windows; first Windows verification

## Phase 2 — Secure runtime and production infrastructure (current)

- [x] Per-launch session secret + HMAC-signed requests through a Rust IPC proxy (ADR-010)
- [x] Desktop-owned service lifecycle: API with the app, worker on request, crash detection, bounded restarts, orphan cleanup (ADR-012)
- [x] Resource monitoring (memory, CPU, disk, per-process) behind a platform probe; worker memory guard
- [x] Durable job infrastructure: `jobs` table, atomic claims, leases, heartbeats, retries with backoff + jitter, cancellation, idempotency, restart recovery (ADR-011)
- [x] JSON logs with rotation/retention/redaction; Diagnostics screen and export (ADR-013)
- [x] DB backup, integrity check, staged restore, pre-migration backups, corruption refusal
- [x] CI + security workflows, Dependabot (ADR-014); Playwright browser E2E
- [x] Security audit (docs/SECURITY.md)
- [ ] Production sidecars (Node runtime + bundle, PyInstaller worker), signing — see RUNTIME_LIFECYCLE.md
- [ ] Windows: Job Object for child processes, first native verification
- [ ] Worker request signing before any non-health worker endpoint (SECURITY.md M2)

Moved to Phase 3: channels CRUD and real dashboard queries; Ollama service management.

## Phase 3 — Domain data and model lifecycle

- Channels CRUD, real dashboard queries; domain jobs referencing the `jobs` queue
- Model lifecycle manager on top of the resource probe (RAM/VRAM budgets, one model at a time); Ollama start/stop

## Phase 4 — Content pipeline

- Ollama-backed ideation and scripting
- TTS (Kokoro/Piper), whisper.cpp transcription
- Media library with rights tracking and import validation

## Phase 5 — Rendering

- FFmpeg pipelines (streamed, chunked), Remotion composition, caption animation, thumbnails

## Phase 6 — Publishing

- YouTube OAuth (tokens in OS keychain), upload as private by default, scheduling, explicit human approval before anything public
