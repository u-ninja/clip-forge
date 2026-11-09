# Architecture

## Overview

```
ClipForge Local
      │
      ▼
Tauri desktop runtime (Rust, apps/desktop/src-tauri)
      │   owns: session secret, service manager, resource probe, log files
      ├── React frontend (webview) ── IPC only (api_request, runtime_status, worker_start, …)
      │
      ├── Secure API communication: Rust signs every request (HMAC, per-launch secret)
      │       │
      │       ▼
      │    Fastify API (services/api) 127.0.0.1:4317 — started with the app
      │       ├── SQLite (user data dir, single owner)
      │       └── Durable job queue (jobs table + in-process runner)
      │
      └── Worker manager
              │  started only on request; memory-guarded
              ▼
          Python worker (services/worker) 127.0.0.1:4318
```

Rule: **UI → Tauri IPC → Rust runtime → Fastify → database / worker.** The UI has no network access to services (CSP) and never sees credentials. ESLint forbids importing the database from the UI.

Details: [RUNTIME_LIFECYCLE.md](RUNTIME_LIFECYCLE.md) (processes), [SECURITY.md](SECURITY.md) (auth, threat model), [OPERATIONS.md](OPERATIONS.md) (logs, backups, jobs, CI).

## Components

| Module                   | Responsibility                                                                                                                                              | Depends on                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `packages/shared`        | Constants, Zod contracts (API + IPC/runtime), job kinds and state machine.                                                                                  | zod                            |
| `packages/database`      | Drizzle schema, migrations, connection (WAL, FKs, busy timeout), paths, backup/restore/integrity.                                                           | shared, drizzle, sqlite        |
| `services/api`           | HTTP API: config, request signing, host/browser guards, errors, jobs (store + runner), DB ops, diagnostics.                                                 | shared, database               |
| `services/worker`        | Python service for future AI/media work; compute-backend detection; parent watchdog.                                                                        | FastAPI, Pydantic              |
| `apps/desktop/src-tauri` | Rust runtime: `auth` (secret, signing), `services` (lifecycle), `process` (spawn, tree kill), `resources` (probe), `logs`, `diagnostics`, `commands` (IPC). | tauri, tokio, reqwest, sysinfo |
| `apps/desktop/src`       | React UI. Talks only to `lib/ipc.ts`. Mock dashboard figures stay isolated in `features/dashboard/mock-data.ts`.                                            | shared                         |

Packages export TypeScript source under a `source` condition (used by dev tools and typecheck) and compiled `dist/` for production builds.

## Process model and resources (16 GB baseline)

- Launch starts the Tauri window and the **API**. The worker starts only when requested (Settings today; features later) and is refused when free memory is below `CLIPFORGE_WORKER_MIN_FREE_MB`. Ollama is never auto-started.
- One worker process at most; crash restarts are bounded; all children stop with the app (RUNTIME_LIFECYCLE.md).
- Jobs run at most `CLIPFORGE_JOB_CONCURRENCY` at a time (default 1); the queue is capped (`CLIPFORGE_JOB_MAX_QUEUED`), so producers get backpressure (429) rather than unbounded growth.
- Resource snapshots (`resources.rs`, `ResourceProbe` trait, `sysinfo` implementation for macOS/Windows) are taken on demand only — no background sampling. The future model lifecycle manager will consult the same probe.
- No Docker, Redis, or other background daemons.

## Data

- SQLite file: `<user data dir>/data/app.db` (`CLIPFORGE_DATABASE_PATH` / `CLIPFORGE_DATA_DIR` override). WAL mode, `foreign_keys=ON`, 5 s busy timeout.
- Data from the pre-rename identifier (`com.youtubeclipper.desktop`) is copied once into the current directory on first start; see ADR-009.
- Tables: `jobs` (execution queue, ADR-011), `channels`, `channel_profiles`, `content_ideas`, `sources`, `media_assets`, `media_rights`, `production_jobs`, `scripts`, `voiceovers`, `render_jobs`, `publishing_jobs`.
- Every job table shares resumable fields: `status` (shared state machine), `attempt`/`max_attempts`, `progress`, `checkpoint` (JSON), `last_error`, `lease_owner`/`lease_expires_at` (detect orphaned work after a crash), `started_at`/`finished_at`, `idempotency_key` where duplicates matter.
- Media paths are stored relative to the managed storage root. Publishing defaults to `private` visibility.
- **No credentials in SQLite.** YouTube OAuth tokens will be stored in macOS Keychain / Windows Credential Manager (via the Rust `keyring` crate in the Tauri shell), keyed by channel id.

## Security model

Summary (full model and audit in [SECURITY.md](SECURITY.md)):

- API and worker bind to loopback only (validated at startup). The API rejects non-loopback `Host` headers (DNS rebinding) and any browser-originated request (`Origin` / `Sec-Fetch-*`); there is no CORS.
- Every API route except `/health` requires an HMAC signature made with the per-launch secret held by the Rust runtime (ADR-010).
- Tauri: `core:default` plus explicitly granted app commands; no shell/fs/http plugins; CSP `connect-src` allows only IPC.

## Platform abstraction

- Data dirs resolved per OS in `packages/database/src/paths.ts` (matches Tauri `appDataDir`, which the Rust runtime uses).
- Resources: `ResourceProbe` (Rust) with a `sysinfo` implementation; process termination per OS in `process.rs` (process groups + signals on Unix, `taskkill /T` on Windows).
- Compute backend (`metal` / `cuda` / `cpu`) detected in `services/worker/worker/compute.py`; model code must ask it rather than checking the OS.
