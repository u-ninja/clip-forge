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

## ADR-005: Loopback API without auth in Phase 1

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
