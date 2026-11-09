# ClipForge Local

Local-first, AI-assisted video production desktop app. Everything — UI, API, database, AI workers — runs on your machine. No Docker, no Redis, no cloud dependency for the core app.

**Status:** Phase 2 (secure runtime and infrastructure). See [docs/ROADMAP.md](docs/ROADMAP.md).

> Coding agents and contributors: [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) is mandatory.

## Stack

| Part               | Tech                                                 | Path                |
| ------------------ | ---------------------------------------------------- | ------------------- |
| Desktop shell + UI | Tauri 2, Rust, React 19, Vite, Tailwind 4, shadcn/ui | `apps/desktop`      |
| Local API          | Node, Fastify 5, Zod                                 | `services/api`      |
| AI / media worker  | Python, FastAPI, Pydantic                            | `services/worker`   |
| Database           | SQLite (better-sqlite3), Drizzle ORM + Kit           | `packages/database` |
| Shared contracts   | TypeScript + Zod                                     | `packages/shared`   |

## Prerequisites

macOS (Apple Silicon) or Windows 10/11. Check with `pnpm doctor`.

- Node.js ≥ 22, pnpm ≥ 10 (`corepack enable` or `brew install pnpm`)
- Rust stable (`brew install rust` or rustup) + Xcode Command Line Tools (macOS) / MSVC Build Tools + WebView2 (Windows)
- Python ≥ 3.12 (worker only)
- Optional, later phases: FFmpeg, Ollama

## Setup

```sh
pnpm install
cp .env.example .env        # optional; defaults work
pnpm db:migrate             # optional; the API also migrates on start
```

## Daily commands

```sh
pnpm dev            # desktop app; it starts and stops the API itself
pnpm dev:api        # API standalone (needs CLIPFORGE_API_SECRET, see DEVELOPMENT.md)
pnpm dev:worker     # creates the worker venv / runs the worker standalone

pnpm typecheck      # tsc across all workspaces
pnpm lint           # ESLint (strict, type-aware)
pnpm format         # Prettier
pnpm test           # Vitest (TS) + pytest (worker)
pnpm --filter @clipforge/desktop test:e2e   # Playwright (browser, mocked IPC)
pnpm build          # build all packages, API and frontend
pnpm build:desktop  # native app bundle (.app/.dmg, .msi)

pnpm db:generate    # new migration after editing packages/database/src/schema.ts
pnpm db:migrate     # apply migrations to the user-data database
```

Data lives in the OS user-data directory, never in the repo:
macOS `~/Library/Application Support/com.clipforge.local/`, Windows `%APPDATA%\com.clipforge.local\`.

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, boundaries, data flow
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — environment, commands, troubleshooting
- [DECISIONS.md](docs/DECISIONS.md) — architecture decision records
- [ROADMAP.md](docs/ROADMAP.md) — phases
- [PHASE_SUMMARIES.md](docs/PHASE_SUMMARIES.md) — final summary of each completed phase
- [ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) — mandatory rules
- [SECURITY.md](docs/SECURITY.md) — threat model, auth design, audit findings, CI severity policy
- [RUNTIME_LIFECYCLE.md](docs/RUNTIME_LIFECYCLE.md) — service startup/shutdown, process ownership, packaging
- [OPERATIONS.md](docs/OPERATIONS.md) — logs, diagnostics, backup/restore, jobs, CI, dependency updates
