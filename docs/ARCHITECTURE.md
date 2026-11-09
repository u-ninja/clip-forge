# Architecture

## Overview

```
┌──────────────── Tauri desktop app (apps/desktop) ────────────────┐
│  React UI (webview)  ──HTTP (CORS, CSP-limited)──┐               │
│  Rust shell: window, OS integration, no custom commands yet       │
└───────────────────────────────────────────────────┼──────────────┘
                                                    ▼
                         Fastify API (services/api) 127.0.0.1:4317
                         - single owner of the SQLite database
                         - orchestrates jobs (later phases)
                           │                         │ HTTP, on demand
                           ▼                         ▼
             SQLite (user data dir)       Python worker (services/worker) 127.0.0.1:4318
             via packages/database        - AI/media tasks behind compute backends
                                          - started only when work needs it
```

Rule: **UI → Tauri IPC / local API → Fastify → database / worker.** The UI never opens the database or calls the worker directly (enforced for the DB by an ESLint import restriction).

## Components

| Module              | Responsibility                                                                        | Depends on              |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `packages/shared`   | Constants (ports, origins, app id), Zod API contracts, job state machine.             | zod                     |
| `packages/database` | Drizzle schema, migrations, connection setup (WAL, FKs, busy timeout), data paths.    | shared, drizzle, sqlite |
| `services/api`      | HTTP API: config validation, logging, CORS, host check, errors, migrations on boot.   | shared, database        |
| `services/worker`   | Python service for future AI/media work; compute-backend detection.                   | FastAPI, Pydantic       |
| `apps/desktop`      | Tauri shell and React UI. Mock data is isolated in `features/dashboard/mock-data.ts`. | shared (types only)     |

Packages export TypeScript source under a `source` condition (used by dev tools and typecheck) and compiled `dist/` for production builds.

## Process model and resources (16 GB baseline)

- Desktop start launches **only** the Tauri window. The API is started separately in Phase 1 (sidecar in a later phase); the worker and Ollama are never started automatically.
- Each service can be started and stopped independently.
- Worker defaults to one concurrent job (`CLIPFORGE_WORKER_MAX_JOBS=1`); one large model at a time.
- No Docker, Redis, or other background daemons.

## Data

- SQLite file: `<user data dir>/data/app.db` (`CLIPFORGE_DATABASE_PATH` / `CLIPFORGE_DATA_DIR` override). WAL mode, `foreign_keys=ON`, 5 s busy timeout.
- Data from the pre-rename identifier (`com.youtubeclipper.desktop`) is copied once into the current directory on first start; see ADR-009.
- Tables: `channels`, `channel_profiles`, `content_ideas`, `sources`, `media_assets`, `media_rights`, `production_jobs`, `scripts`, `voiceovers`, `render_jobs`, `publishing_jobs`.
- Every job table shares resumable fields: `status` (shared state machine), `attempt`/`max_attempts`, `progress`, `checkpoint` (JSON), `last_error`, `lease_owner`/`lease_expires_at` (detect orphaned work after a crash), `started_at`/`finished_at`, `idempotency_key` where duplicates matter.
- Media paths are stored relative to the managed storage root. Publishing defaults to `private` visibility.
- **No credentials in SQLite.** YouTube OAuth tokens will be stored in macOS Keychain / Windows Credential Manager (via the Rust `keyring` crate in the Tauri shell), keyed by channel id.

## Security model (Phase 1)

- API and worker bind to loopback only; config validation rejects other hosts.
- API rejects requests whose `Host` header isn't loopback (DNS-rebinding guard) and allows CORS only from the desktop origins (`http://localhost:1420`, `tauri://localhost`, `http://tauri.localhost`).
- Tauri: capabilities grant `core:default` only — no shell, fs, or http plugins; strict CSP with `connect-src` limited to the API.
- Not yet: a per-session API token. Loopback + origin checks don't stop other local processes; a token handed from the Tauri shell to the API is planned before any state-changing endpoint ships.

## Platform abstraction

- Data dirs resolved per OS in `packages/database/src/paths.ts` (matches Tauri `appDataDir`).
- Compute backend (`metal` / `cuda` / `cpu`) detected in `services/worker/worker/compute.py`; model code must ask it rather than checking the OS.
