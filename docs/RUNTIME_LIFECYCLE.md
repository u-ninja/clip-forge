# Runtime lifecycle

How the desktop app owns its local services. Code: `apps/desktop/src-tauri/src/` (`services.rs`, `process.rs`, `runtime.rs`).

## Process ownership

```
ClipForge Local (Tauri, Rust)          ← owns everything below; one secret per launch
 ├─ React UI (webview)                 ← no network access to services; IPC only
 ├─ API   (Node/Fastify, 127.0.0.1:4317)  started with the app, restarted on crash
 └─ Worker (Python/FastAPI, 127.0.0.1:4318) started only on request
```

- Each child is spawned with an **argument array** (never a shell string), `stdin` closed, stdout/stderr captured, and an **allowlisted environment** (`process.rs::INHERITED_ENV` plus explicit values). Tokens in the user's shell, proxy settings etc. are not inherited.
- On Unix each child gets its **own process group**, so the whole tree (e.g. `pnpm → tsx → node`) is signalled together. On Windows the tree is ended with `taskkill /T`.
- Every child receives `CLIPFORGE_PARENT_PID`. The API (all platforms) and the worker (POSIX) poll it every 2 s and exit if the desktop process is gone. The API then also signals its own process group, so dev wrappers (`pnpm`, `tsx watch`) don't linger.

## States

`stopped → starting → running → stopping → stopped`, plus `failed { reason }`. The UI reads them via the `runtime_status` command (served from memory, polled every 2 s).

| Event                             | Result                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| App launch                        | API `starting`; worker `stopped`                                                                    |
| Port already taken                | Wait up to 5 s (a crashed session's API exits on its own), then `failed: Port … in use`             |
| Ready                             | API: authenticated `GET /api/v1/version` succeeds. Worker: `GET /health` → `{"status":"ok"}`        |
| Not ready within 45 s             | Tree killed, `failed: did not become ready`                                                         |
| Exits during startup              | `failed: exited during startup` (no automatic retry)                                                |
| API answers 401 to the probe      | `failed`: another process (e.g. a second ClipForge) owns the port                                   |
| Crash while running               | Automatic restart after 1 s, 2 s, 4 s; at most 3 crashes per 10 min, then `failed` (manual restart) |
| Start requested while starting/up | No-op (no duplicate processes)                                                                      |
| Worker start with low free memory | Refused (`CLIPFORGE_WORKER_MIN_FREE_MB`, default 1024)                                              |
| Stop / app quit / SIGTERM         | SIGTERM to the group, wait for the tree to drain (8 s), then SIGKILL the group                      |
| Desktop killed (crash, `kill -9`) | Children notice the missing parent within ~2 s and shut down gracefully                             |

Late events from an old process (a monitor seeing an exit after a restart) are ignored via a per-service generation counter.

## Development vs production

|                | Development (`pnpm dev:desktop`, debug build)                                                   | Production (release build)                           |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| API            | `pnpm --filter @clipforge/api dev` from the repo (tsx watch → hot reload)                       | Sidecar `clipforge-api[.exe]` next to the app binary |
| Worker         | `services/worker/.venv/bin/python -m worker.main` (create the venv once with `pnpm dev:worker`) | Sidecar `clipforge-worker[.exe]`                     |
| Logs           | Files **and** mirrored to the terminal                                                          | Files only                                           |
| Mode detection | `cfg!(debug_assertions)`                                                                        |                                                      |

`pnpm dev:api` and `pnpm dev:worker` still work standalone for backend-only work (see DEVELOPMENT.md).

## Production packaging (not built yet)

Release builds look for sidecars and report `failed: This build does not include the clipforge-api runtime` until they exist. Development spawning cannot be shipped as-is: users have neither Node nor Python, and the repo paths don't exist.

Plan and constraints (investigated, ADR-012):

- **API.** A single Node SEA executable can't simply embed `better-sqlite3`, because it is a native `.node` addon that must be loaded from disk. The plan is to ship the official Node runtime binary per target as the `clipforge-api` sidecar entry point. Alongside it go an esbuild bundle of `services/api` (ESM, `--platform=node`), the `better-sqlite3` prebuilt `.node` for the target, and `packages/database/drizzle/` migrations as Tauri `resources`. Expected size is ~45 MB (Node) + ~3 MB.
- **Worker.** PyInstaller `--onedir` (or python-build-standalone + site-packages) per target as `clipforge-worker`. It ships only `requirements.txt` dependencies; AI dependencies are added per backend later.
- **Tauri wiring.** Add `bundle.externalBin: ["binaries/clipforge-api", "binaries/clipforge-worker"]`. Tauri requires per-target file names (`clipforge-api-aarch64-apple-darwin`, `clipforge-api-x86_64-pc-windows-msvc.exe`) and strips the suffix when bundling, which is what `runtime.rs::sidecar` expects. Resources go under `bundle.resources`.
- **Targets.**
  - First: `aarch64-apple-darwin`.
  - Designed for: `x86_64-pc-windows-msvc`. It needs a Windows Job Object (KILL_ON_JOB_CLOSE) so children die with the app even on a crash, because the Python worker has no parent watchdog on Windows (SECURITY.md M3).
- **Signing.** On macOS the sidecars must be signed and notarized with the app (hardened runtime). Node needs the `allow-jit` entitlement.
- **Secret handoff.** Pass the secret on stdin instead of the environment once the sidecar exists (SECURITY.md M1). The dev path keeps env because `tsx watch` restarts its child.

## Manual native checklist

Browser E2E tests mock IPC, so they cannot prove native behaviour. Before a release, verify on each OS:

1. Launch → Settings shows API **Online** within a few seconds; `lsof -iTCP:4317` shows one listener.
2. Settings → Worker **Start** → Online; **Stop** → Offline; port 4318 released.
3. `kill -9` the API's node process → it comes back (restart policy); kill it 4× quickly → `failed` with a reason.
4. Quit the app (Cmd+Q / close window) → no `node`/`python` processes remain; `api.log` ends with `shutting down` / `stopped`.
5. `kill -9` the desktop process → within ~3 s no child processes remain.
6. Start a self-test job in Production Queue, quit mid-run, relaunch → the job is re-queued (`INTERRUPTED`) and completes.

Last run on macOS (Apple Silicon, dev build, 2026-11-09): items 1, 4 (via SIGTERM, the same exit path), and 5 were verified. Items 2, 3 and 6 are covered by automated tests (`cargo test` lifecycle tests, API runner tests) but were not clicked through natively. Windows: not yet run.
