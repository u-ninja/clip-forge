# CLAUDE.md

ClipForge Local is a local-first AI video production desktop app: Tauri 2 + React (`apps/desktop`), Fastify API on 127.0.0.1 (`services/api`), Python FastAPI worker (`services/worker`), SQLite + Drizzle (`packages/database`), shared Zod schemas (`packages/shared`).

**Read `docs/ENGINEERING_STANDARDS.md` before any change; it is mandatory.**

Also see: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADRs), `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, `docs/RUNTIME_LIFECYCLE.md`, `docs/OPERATIONS.md`.

## Commands

- `pnpm dev:desktop` / `pnpm dev:api` / `pnpm dev:worker`
- `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm --filter @clipforge/desktop test:e2e`
- `cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- `pnpm db:generate` (new migration) / `pnpm db:migrate`

## Hard rules (most often violated)

1. The UI never touches the DB, API or worker directly; it calls Tauri IPC (`apps/desktop/src/lib/ipc.ts`), and Rust signs API requests.
2. Validate all external input with Zod (HTTP, IPC, files, env, worker and third-party responses).
3. No unrestricted shell/spawn with untrusted strings; use argument arrays.
4. Never store or log secrets; OAuth tokens go to the OS keychain (Keychain / Credential Manager).
5. Persist job state; no in-memory-only queues.
6. One AI model loaded at a time by default.
7. Every API route except `GET /health` stays authenticated; session credentials never reach the webview, logs or disk.
8. Only the desktop runtime spawns service processes; Tauri commands never take programs, args, paths or env from the frontend, and each needs an explicit capability permission.
9. Browser E2E tests run against mocked IPC: never report them as native desktop coverage.

Never disable tests or lint rules to make a build pass. Report Definition of Done items you did not complete.
