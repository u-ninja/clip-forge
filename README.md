# ClipForge Local

Local-first, AI-assisted video production desktop app. Everything — UI, API, database, AI workers — runs on your machine. No Docker, no Redis, no cloud dependency for the core app.

**Status:** Phase 1 (foundation). See [docs/ROADMAP.md](docs/ROADMAP.md).

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
pnpm dev            # API + desktop app together
pnpm dev:api        # API only     → http://127.0.0.1:4317/health
pnpm dev:desktop    # desktop app only (Vite on :1420 + Tauri window)
pnpm dev:worker     # Python worker on demand → http://127.0.0.1:4318/health

pnpm typecheck      # tsc across all workspaces
pnpm lint           # ESLint (strict, type-aware)
pnpm format         # Prettier
pnpm test           # Vitest (TS) + pytest (worker)
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
- [ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) — mandatory rules
