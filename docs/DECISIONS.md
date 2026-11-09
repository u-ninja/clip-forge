# Architecture Decision Records

Format: Context · Decision · Alternatives · Consequences / trade-offs. Add a new ADR for every significant decision; never rewrite accepted ones — supersede them.

## ADR-001: pnpm workspaces without Turborepo/Nx

- **Context:** Five workspaces, one developer, builds take seconds.
- **Decision:** Plain pnpm workspaces; `pnpm -r` handles topological order.
- **Alternatives:** Turborepo, Nx.
- **Consequences:** No remote cache or task graph. Revisit when build times or CI cost justify it.

## ADR-002: Fastify API as a separate Node process, not Rust commands

- **Context:** Business logic and DB access need a home that is testable, typed end-to-end with the UI, and fast to iterate.
- **Decision:** Node + Fastify service owns the database and orchestration; Tauri's Rust side stays a thin shell (window, OS integration, credential store later).
- **Alternatives:** All logic in Tauri commands (Rust); Node logic inside the webview.
- **Consequences:** One extra process (measured ~92 MB RSS in dev mode under tsx; production RSS not yet measured; desktop debug build ~100 MB). Shared Zod contracts across UI and API. The API will become a Tauri sidecar in Phase 2.

## ADR-003: SQLite via better-sqlite3 + Drizzle, single writer

- **Context:** Local-first, no server database; Drizzle requested.
- **Decision:** drizzle-orm 0.45 (stable) + drizzle-kit 0.31 with better-sqlite3 13 (ships N-API prebuilds for macOS arm64 and Windows x64 — no compiler needed). WAL, foreign keys, 5 s busy timeout. The API is the only process that opens the DB.
- **Alternatives:** Drizzle 1.0 RC (not yet stable), `node:sqlite` (driver support is still in Drizzle betas), libSQL.
- **Consequences:** Synchronous driver; fine for local workloads, long queries must stay off hot paths. Migrate to Drizzle 1.0 once it's stable.

## ADR-004: Data in the OS user-data directory

- **Context:** App data must not live in the repo and must work on macOS and Windows.
- **Decision:** `<appDataDir>/<identifier>/` (same path Tauri's `appDataDir()` returns); `CLIPFORGE_DATA_DIR` overrides it for tests.
- **Consequences:** Paths in the DB are relative to the storage root so data survives moves. `storage/` in the repo is a placeholder layout only and is gitignored.

## ADR-005: Loopback API without auth in Phase 1 (superseded by ADR-010)

- **Context:** No auth requested yet, but localhost isn't a trust boundary.
- **Decision:** Bind to loopback (validated), restrict CORS to desktop origins, reject non-loopback `Host` headers. Only read-only endpoints exist.
- **Alternatives:** Unix socket / named pipe; per-session token now.
- **Consequences:** Other local processes can still read health/version. A per-session token from the Tauri shell is required before any state-changing endpoint ships (Phase 2).

## ADR-006: Python worker started on demand, backend detection without torch

- **Context:** 16 GB RAM baseline; AI deps are huge.
- **Decision:** FastAPI worker, never auto-started; `compute.py` picks `metal` / `cuda` / `cpu` from cheap checks; no torch/whisper in Phase 1.
- **Consequences:** CUDA detection is a heuristic (`nvidia-smi` present) until a real model loader exists.

## ADR-007: Workspace packages export source under a `source` condition

- **Context:** Compiled packages need rebuilding on every edit during development; source-only packages break the Node production build.
- **Decision:** `exports` lists `source` → `src/index.ts` first, then `types`/`default` → `dist`. tsx (`--conditions=source`), Vite and `tsc --noEmit` (`customConditions`) use source; `tsc` builds and Node production use dist.
- **Consequences:** Edits hot-reload without rebuilds. Build tsconfigs must reset `customConditions` to `[]`.

## ADR-008: Hash routing in the desktop UI

- **Context:** Bundled assets are served from `tauri://localhost` with no history fallback.
- **Decision:** `HashRouter` from react-router.
- **Consequences:** URLs have a `#`; irrelevant in a desktop window.

## ADR-009: Rename to ClipForge Local, with a one-time data-directory copy

- **Context:** The project started under the working name `youtube-clipper` (`@yc/*`, identifier `com.youtubeclipper.desktop`, `YC_*` env vars). The product name is now ClipForge Local. The Tauri identifier names the OS user-data directory, so changing it moves where data is resolved.
- **Decision:** Rename to `clipforge-local` / `@clipforge/*` / `com.clipforge.local` / `CLIPFORGE_*`. On startup (API and `db:migrate`), before opening the database, `migrateLegacyDataDir()` copies the legacy directory to the new one when the new one does not exist yet. The copy is staged in `<target>.migrating` and renamed into place atomically. Legacy ids are listed in `LEGACY_APP_IDS` in `packages/shared`.
- **Alternatives:** Keep the old identifier forever (permanent naming mismatch); move the directory (no backup if something goes wrong); prompt the user (no UI for it yet).
- **Consequences:** The legacy directory stays on disk as a backup and is never written to; the user can delete it manually. If both directories exist, nothing is copied — the new one wins. `YC_*` env vars are no longer read (no released builds or committed `.env` files used them). Tauri webview storage under the old id isn't migrated because the app stores nothing there yet.

## ADR-010: Rust-held session secret and signed requests between UI and API

- **Context:** Loopback + CORS doesn't stop other local processes, and the webview could reach the API directly. A bearer token in frontend JS would be readable by any script running in the webview, and a static token can't express expiry or prevent replay. State-changing endpoints (jobs, backups, restore) arrive in Phase 2.
- **Decision:**
  - The Tauri Rust runtime generates a 256-bit secret per launch and passes it only to the API child it spawns.
  - The UI calls a single IPC command, `api_request(method, path, body)`. Rust validates the method and path (`/api/v1/*` only), signs the request with HMAC-SHA256 (method, path+query, timestamp, nonce, body hash) and forwards it to `127.0.0.1`.
  - The API verifies the signature (constant-time), a ±30 s window and a nonce replay cache, and rejects anything carrying browser headers (`Origin`, `Sec-Fetch-*`). CORS and `@fastify/cors` are removed; the CSP no longer allows the webview to connect to the API.
  - `/health` is the only public route.
- **Alternatives:**
  - Bearer token injected into JS: exposed to XSS, no replay or expiry protection.
  - Unix socket / named pipe: no TCP surface, but needs platform-specific code in Node, the worker and Rust, and doesn't help Windows today.
  - Tauri HTTP plugin from JS: still puts the credential in JS.
  - mTLS: certificate management for a loopback hop.
- **Consequences:**
  - Credentials rotate on every restart. Captured requests can't be replayed or altered, and web pages can't call the API at all.
  - Every API call costs one IPC hop plus an HMAC, which is negligible locally.
  - `pnpm dev:api` standalone needs `CLIPFORGE_API_SECRET` (dev helper: `pnpm --filter @clipforge/api call`).
  - Trade-offs: the secret travels via the child's environment, which same-user tools can read (SECURITY.md M1, stdin planned for production). A compromised webview can still use `api_request` like the real UI; that's inherent, and limited by server-side validation and the command allowlist.

## ADR-011: Generic durable `jobs` table executed by an in-API runner

- **Context:** Phase 2 needs durable execution (leases, retries, cancellation, recovery) before any production feature. The existing domain job tables (`production_jobs`, `render_jobs`, …) carry lease fields, but they require domain foreign keys (a channel), so infrastructure jobs can't live there.
- **Decision:**
  - Add one `jobs` table as the execution queue: kind, payload, status, priority, attempts, run_after, lease_owner/lease_expires_at/heartbeat_at, cancel_requested, structured error, result, idempotency key.
  - `JobStore` changes state only through guarded UPDATEs inside `BEGIN IMMEDIATE` transactions, validated against the shared state machine.
  - `JobRunner` runs inside the API, the single DB owner. It claims jobs up to a concurrency limit, heartbeats, and enforces timeouts, cancellation and graceful release on shutdown.
  - On startup it re-queues every job still `running`, since only one API process exists per data directory.
- **Alternatives:**
  - Run jobs on `production_jobs` directly: couples execution to the domain and can't host infrastructure jobs.
  - Redis or BullMQ: an extra daemon, contrary to ADR-001 and the standards.
  - Worker-side queue: the worker isn't always running and doesn't own the DB.
- **Consequences:**
  - Domain rows will reference `jobs` rows in later phases. Their duplicated lease columns should then be dropped (a migration in Phase 3+).
  - The startup-recovery rule assumes a single runner per database. A second runner process would need lease-expiry recovery only (already implemented and tested).

## ADR-012: Desktop runtime owns service processes; sidecars for production

- **Context:** Users must not start services by hand; orphaned or duplicate processes must not survive; production users have neither Node nor Python.
- **Decision:**
  - A Rust service manager (tokio) spawns the API at launch and the worker on request, with argument arrays, an allowlisted env, an own process group, captured output, authenticated readiness, bounded crash restarts (3 per 10 min) and tree termination.
  - Children also watch their parent PID.
  - Development spawns the repo's dev commands (hot reload). Production resolves `clipforge-api` / `clipforge-worker` sidecars next to the executable; they aren't built yet (RUNTIME_LIFECYCLE.md describes the packaging plan).
- **Alternatives:**
  - Tauri's shell plugin `Command.sidecar` from JS: exposes process control to the frontend.
  - A launchd/Windows service: background daemons outlive the app, contrary to the standards.
  - The API spawning the worker: the API would need to manage processes and resources it can't observe as well.
- **Consequences:** The app owns cleanup on all exit paths except a hard crash on Windows (needs a Job Object, SECURITY.md M3). The release build can't run services until the sidecars are packaged.

## ADR-013: Log files and rotation owned by the desktop runtime

- **Context:** Logs must be structured, bounded, rotated and redacted across three processes in two languages.
- **Decision:** Services keep writing JSON to stdout (pino, Python `JsonFormatter`). The Rust runtime captures it, redacts it, writes `<data>/logs/<service>.log` with size rotation, and applies retention and a directory cap at startup. It keeps the last 50 warnings/errors in memory for diagnostics.
- **Alternatives:** Rotation in each service (pino-roll, Python handlers) means three implementations and three policies; `tracing-appender` only rotates by time.
- **Consequences:** One policy and one redaction point. A service started standalone logs to its terminal only.

## ADR-014: GitHub Actions + Dependabot, actions pinned by SHA

- **Context:** The standards require CI and automated dependency/security checks; supply-chain incidents in 2025–2026 hit popular actions through mutable tags.
- **Decision:**
  - Two workflows: `ci.yml` (quality and tests) and `security.yml` (Gitleaks, Trivy, pnpm audit, pip-audit), with least-privilege permissions and `pull_request` only.
  - Actions are pinned by commit SHA and the Trivy binary by version.
  - Dependabot over Renovate: built in, no app installation. It groups minor/patch updates and applies a 7-day cooldown.
- **Consequences:** Dependabot also bumps the pinned SHAs. Branch protection, which actually requires the checks, must be configured in GitHub. pnpm 12 lockfile support in Dependabot is assumed; if its PRs fail to update `pnpm-lock.yaml`, switch to Renovate.
