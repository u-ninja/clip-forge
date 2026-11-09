# Phase Summaries

The final summary of each completed phase: what shipped, how it was verified, and what was knowingly left open. Plans live in [ROADMAP.md](ROADMAP.md); decisions live in [DECISIONS.md](DECISIONS.md).

---

## Phase 1 — Foundation

**Goal:** A working, standards-enforced monorepo skeleton for a local-first desktop app.

### Delivered

- **Monorepo.** pnpm workspaces (ADR-001), strict TypeScript, strict type-aware ESLint (including an import boundary that stops the UI from touching the DB), Prettier and Vitest.
- **Desktop.** Tauri 2 and React 19 shell with Vite, Tailwind 4 and shadcn/ui, a dark theme, sidebar navigation, a mock dashboard (sample data isolated in one module), hash routing (ADR-008) and live API status.
- **API.** Fastify with `/health` and a version endpoint, Zod-validated env config, JSON logs (pino), a loopback-only bind, a Host allowlist (DNS rebinding guard), CORS for the desktop origins, a uniform error envelope and graceful shutdown.
- **Database.** SQLite through better-sqlite3 and Drizzle (ADR-003): 11 core tables with shared resumable job fields, migrations, WAL, foreign keys and a busy timeout. Data lives in the OS user-data directory (ADR-004). A one-time legacy data-directory copy handles the rename to ClipForge Local (ADR-009).
- **Worker.** Python FastAPI skeleton with `/health` and compute-backend detection (`metal` / `cuda` / `cpu`) without importing torch (ADR-006). Started on demand only.
- **Shared contracts.** Zod contracts and the job state machine in `packages/shared`. Packages export source under a `source` condition for hot reload (ADR-007).
- **Docs.** ENGINEERING_STANDARDS (mandatory), ARCHITECTURE, DECISIONS, DEVELOPMENT, ROADMAP, AGENTS/CLAUDE.

### Verified

Typecheck, lint, format, Vitest, pytest and builds all pass.

### Left open (carried forward)

- **Done in Phase 2:** CI, secret and vulnerability scanning, dependency automation and Playwright.
- **Still open:** a PowerShell worker script and first Windows verification.
- **Accepted for Phase 1 (ADR-005):** the API had no authentication, because only read-only endpoints existed.

---

## Phase 2 — Secure Runtime & Production Infrastructure

**Goal:** Turn the prototype into a managed desktop application with secure service communication, process ownership, durable jobs, diagnostics and CI, before any AI or video work.

### Delivered

- **API session authentication (ADR-010).**
  - The Rust runtime generates a fresh 256-bit secret per launch. The UI calls one IPC command (`api_request`), and Rust signs each request with HMAC-SHA256 over method, path, timestamp, nonce and body hash.
  - The API checks the signature in constant time, enforces a ±30 s window, keeps a bounded nonce replay cache and rejects browser-originated requests. CORS is removed.
  - The webview CSP can no longer reach the API, and the secret never reaches JS, logs or disk.
- **Service lifecycle (ADR-012).**
  - The API starts with the app. Readiness is an authenticated probe. Crash restarts are bounded (3 per 10 min), port conflicts are detected rather than duplicated, and shutdown is graceful (SIGTERM, then a tree drain, then a forced sweep).
  - The worker starts only on request, behind a memory guard.
  - Children get argument arrays, an allowlisted environment and their own process group. A parent-PID watchdog makes them exit on their own if the app dies.
  - Production sidecars are investigated and documented (not built).
- **Resource monitoring.** A `ResourceProbe` platform abstraction with a `sysinfo` implementation: system, CPU and disk usage plus per-process-tree memory and CPU, sampled on demand only. It is the foundation for the Phase 3 model lifecycle manager.
- **Durable jobs (ADR-011).**
  - A generic `jobs` table. Claims are atomic (`BEGIN IMMEDIATE`) and respect a concurrency limit.
  - Leases with heartbeats, retries with exponential backoff and jitter, a retry limit and structured errors.
  - Idempotency keys, cancellation, timeouts, queue backpressure (429), and graceful release on shutdown.
  - On startup, jobs that were running when the app stopped are re-queued.
  - A `system.selftest` job kind exercises the whole path.
- **Logging and diagnostics (ADR-013).**
  - JSON-lines logs per service, owned by the Rust runtime: size rotation, retention, a directory cap, redaction (the secret and the home path), correlation ids and job ids.
  - A Diagnostics screen (version, OS, service, DB and job status, resources, processes, recent errors, logs) with a redacted report export.
- **Database reliability.**
  - Verified online backups, a full integrity check, and a staged restore that preserves the replaced DB as a pre-restore backup.
  - An automatic pre-migration backup on upgrade, schema-version reporting, and a refusal to start on a corrupt DB (it is never reset).
  - Data directories are created `0700`.
- **UI.** Live service status, a Settings page (restart the API, start/stop the worker), a Production Queue page (live job progress, cancel), a Diagnostics page with database operations, and an error boundary.
- **CI/CD (ADR-014).**
  - `ci.yml`: typecheck, lint, format, Vitest, pytest, build, Playwright, then rustfmt and clippy on Linux and Windows, plus `cargo test`.
  - `security.yml`: Gitleaks, Trivy (gate on HIGH/CRITICAL with a fix), `pnpm audit` and `pip-audit`.
  - Dependabot covers npm, Cargo, pip and Actions, with grouped minor/patch updates, separate majors and a 7-day cooldown.
  - Actions are pinned by SHA.
- **Security audit** in [SECURITY.md](SECURITY.md). Critical: none. High: 3 found, all fixed. Medium and low findings are documented with status.
- **Docs.** New: SECURITY, RUNTIME_LIFECYCLE, OPERATIONS. Updated: ARCHITECTURE, DEVELOPMENT, DECISIONS (ADR-010–014), ROADMAP, ENGINEERING_STANDARDS, README, AGENTS/CLAUDE (hard rules 7–9).

### Verified (macOS Apple Silicon, dev build)

| Check                                                                                                        | Result                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| typecheck · lint · format · build                                                                            | pass                                                |
| Vitest: shared 4 · database 14 · API 49 (auth, jobs incl. 3-thread concurrent claim, runner, DB routes)      | pass                                                |
| pytest (worker)                                                                                              | 5 pass                                              |
| cargo fmt · clippy `-D warnings` · `cargo test` (21, incl. real process lifecycle)                           | pass                                                |
| Playwright, browser + mocked IPC (UI coverage, **not** native)                                               | 10 pass                                             |
| Gitleaks (history) · Trivy · pip-audit · `pnpm audit --audit-level high`                                     | clean (dev-only moderate/low advisories documented) |
| Native: API start, `kill -9` of the desktop cleans up children, SIGTERM graceful shutdown (3/3), `0700` dirs | verified                                            |

Native runs found and fixed two shutdown bugs that the automated tests missed.

### Open items carried into Phase 3 (release blockers)

| Item                                                                                              | Priority        |
| ------------------------------------------------------------------------------------------------- | --------------- |
| Worker authentication before adding any worker endpoint (SECURITY.md M2)                          | **P0**          |
| Windows Job Object and first native Windows validation (M3)                                       | P1              |
| First GitHub CI and Security workflow runs (never run on GitHub yet)                              | P1              |
| Native walkthrough: worker start/stop, crash restart, quit-mid-job recovery, Cmd+Q / window close | P1              |
| Production API/worker sidecar packaging (RUNTIME_LIFECYCLE.md)                                    | Release blocker |
| Code signing and notarization                                                                     | Release blocker |

macOS development can continue, but **cross-platform release readiness is not claimed**.

Also accepted or open:

- M1: the secret is passed through the child's environment (stdin handoff planned).
- L1: port-squatting mutual auth.
- Branch protection must be enabled in GitHub settings.
