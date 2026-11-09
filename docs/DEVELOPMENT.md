# Development

## Environment

Developed on macOS (Apple Silicon M2, 16 GB, zsh, Homebrew). Windows target: Ryzen 5 5600X, 32 GB, RTX 3070 Ti 8 GB.

Verified Phase 1 toolchain: Node 26.8, pnpm 12.4, Rust 1.99, Python 3.15, Xcode 26.

```sh
pnpm doctor   # scripts/check-prereqs.sh — reports required and optional tools
```

Windows additionally needs: Microsoft C++ Build Tools, WebView2 runtime (preinstalled on Windows 11), Rust via rustup (MSVC toolchain), and `py -3` for the worker (`scripts/worker.sh` is bash; a PowerShell equivalent is pending).

## How the project was scaffolded

```sh
git init
mkdir -p apps services/api/src packages/{database,shared}/src \
  storage/{sources,licensed-media,scripts,voiceovers,renders,thumbnails} docs scripts
cd apps && pnpm create tauri-app@4.7.5 desktop --template react-ts --manager pnpm \
  --identifier com.clipforge.local -y
cd desktop
pnpm add react-router lucide-react
pnpm add -D tailwindcss @tailwindcss/vite @types/node
pnpm dlx shadcn@4.23.0 init -t vite -b radix -p nova --no-monorepo --no-rtl -y
pnpm dlx shadcn@4.23.0 add card badge progress separator -y
(cd src-tauri && cargo remove tauri-plugin-opener)

# root tooling
pnpm add -Dw typescript vitest eslint @eslint/js typescript-eslint eslint-plugin-react-hooks globals prettier @types/node

# packages
(cd packages/shared && pnpm add zod)
(cd packages/database && pnpm add drizzle-orm better-sqlite3 @clipforge/shared@workspace:* \
  && pnpm add -D drizzle-kit @types/better-sqlite3 && pnpm db:generate)
(cd services/api && pnpm add fastify @fastify/cors zod @clipforge/shared@workspace:* @clipforge/database@workspace:* \
  && pnpm add -D tsx pino-pretty)

# worker
cd services/worker && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

Config files that no generator produces (tsconfigs, ESLint, Prettier, `.env.example`) were written with shell heredocs.

## Running

| Command                         | What it does                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:desktop` | Vite on `:1420` + Rust build + native window; the app starts the API itself (hot reload via tsx watch). First Rust build takes ~1–2 min |
| `pnpm dev:api`                  | API alone (backend work). Needs `CLIPFORGE_API_SECRET`, see below                                                                       |
| `pnpm dev:worker`               | Creates the venv if missing and starts the worker standalone. Run it once so the app can start the worker                               |

Don't run `pnpm dev:api` while the desktop app is running; both want port 4317 (the app reports "port in use").

### Calling the API by hand

Every route except `/health` needs a signed request (ADR-010). For a standalone API:

```sh
export CLIPFORGE_API_SECRET=$(openssl rand -hex 32)   # same shell for both commands
pnpm dev:api
pnpm --filter @clipforge/api call GET /api/v1/version
pnpm --filter @clipforge/api call POST /api/v1/jobs '{"kind":"system.selftest","payload":{"durationMs":2000}}'
curl http://127.0.0.1:4317/health                      # public
```

`curl` and `fetch` can't be used for protected routes. `fetch` also adds `Sec-Fetch-*` headers, which the API rejects as browser traffic.

### Logs while developing

The desktop app mirrors every service's JSON log lines to the terminal and writes them to `<data>/logs/` (OPERATIONS.md). Use `CLIPFORGE_DATA_DIR=/tmp/cf pnpm dev:desktop` for a throwaway data directory.

## Quality checks

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
(cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
pnpm --filter @clipforge/desktop exec playwright install chromium   # once
pnpm --filter @clipforge/desktop test:e2e
```

- `pnpm test` builds the packages first, runs Vitest in each workspace, then pytest in the worker venv.
- `cargo test` includes real process lifecycle tests: they spawn `python3`, crash it, and check restarts and tree kills.
- `test:e2e` starts Vite and runs the UI in Chromium against a **mocked** Tauri IPC (`apps/desktop/e2e/mock-runtime.ts`). It tests UI workflows, not the native app; see the native checklist in RUNTIME_LIFECYCLE.md.

CI runs the same commands (`.github/workflows/ci.yml`).

## Database workflow

1. Edit `packages/database/src/schema.ts`.
2. `pnpm db:generate` → new SQL file in `packages/database/drizzle/`. Review it and commit it. Never edit a migration that has shipped.
3. `pnpm db:migrate` (or just restart the API, which migrates on boot).

Use `CLIPFORGE_DATA_DIR=/some/tmp/dir` to point everything at a throwaway database.

## Configuration

All variables are documented in [`.env.example`](../.env.example). The API validates them at startup and exits with a list of problems if any are invalid.

`CLIPFORGE_API_PORT` / `CLIPFORGE_WORKER_PORT` are read by the desktop runtime and passed to the services; nothing else needs changing.

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS`** — build scripts are opt-in under `allowBuilds` in `pnpm-workspace.yaml`. better-sqlite3 v13 ships prebuilt N-API binaries, so its build script is deliberately disabled.
- **Port 1420 in use** — another Vite/Tauri dev session is running; Tauri requires that fixed port.
- **API shows "Failed" in Settings.** The reason is shown under the badge. The last lines are in Diagnostics → Recent errors and `<data>/logs/api.log`. "Port 4317 is in use" usually means a standalone `pnpm dev:api` is running.
- **Worker won't start: "Worker environment missing"** — run `pnpm dev:worker` once to create `services/worker/.venv`, then stop it.
- **API refuses to start with `DB_CORRUPT`** — see OPERATIONS.md, "Database corruption".
- **Leftover processes after a crash** — children exit within ~2 s on their own. If not: `lsof -tiTCP:4317 -tiTCP:4318 | xargs kill`.
