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

| Command            | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `pnpm dev`         | API (tsx watch) and Tauri dev window in parallel                              |
| `pnpm dev:api`     | API on `127.0.0.1:4317`; migrates the DB, then listens                        |
| `pnpm dev:desktop` | Vite on `:1420` + Rust build + native window. First Rust build takes ~1–2 min |
| `pnpm dev:worker`  | Creates the venv if missing, starts the worker on `127.0.0.1:4318`            |

Check services:

```sh
curl http://127.0.0.1:4317/health
curl http://127.0.0.1:4317/api/version
curl http://127.0.0.1:4318/health
```

## Quality checks

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

`pnpm test` builds the packages first, runs Vitest in each workspace, then pytest in the worker venv.

## Database workflow

1. Edit `packages/database/src/schema.ts`.
2. `pnpm db:generate` → new SQL file in `packages/database/drizzle/`. Review it and commit it. Never edit a migration that has shipped.
3. `pnpm db:migrate` (or just restart the API, which migrates on boot).

Use `CLIPFORGE_DATA_DIR=/some/tmp/dir` to point everything at a throwaway database.

## Configuration

All variables are documented in [`.env.example`](../.env.example). The API validates them at startup and exits with a list of problems if any are invalid.

If you change `CLIPFORGE_API_PORT`, also update `connect-src` in `apps/desktop/src-tauri/tauri.conf.json` and `VITE_API_URL`.

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS`** — build scripts are opt-in under `allowBuilds` in `pnpm-workspace.yaml`. better-sqlite3 v13 ships prebuilt N-API binaries, so its build script is deliberately disabled.
- **Port 1420 in use** — another Vite/Tauri dev session is running; Tauri requires that fixed port.
- **API shows "Offline" in the dashboard** — run `pnpm dev:api`, then press Recheck.
- **Stopping the worker on macOS** — the process shows up as `Python` (framework build), so use `lsof -tiTCP:4318 | xargs kill`.
