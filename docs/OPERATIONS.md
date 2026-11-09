# Operations

Day-2 procedures: logs, diagnostics, backups, recovery, upgrades, CI and dependencies.

Data directory (`<data>`): macOS `~/Library/Application Support/com.clipforge.local/`, Windows `%APPDATA%\com.clipforge.local\`, overridable with `CLIPFORGE_DATA_DIR`.

```
<data>/data/app.db               SQLite (WAL)       <data>/logs/<service>.log   JSON lines
<data>/data/backups/*.db         verified backups   <data>/diagnostics/*.json   exported reports
```

## Logs

- One file per service: `desktop.log`, `api.log`, `worker.log`. The desktop runtime writes all three by capturing child stdout/stderr. Lines are JSON; non-JSON output (pnpm banners, Python tracebacks) is wrapped.
- **Fields.** `time`, `level`, `service`, `msg`, plus `operation`, `jobId`, `reqId` (the correlation id, also returned as `x-request-id`) and `duration` where relevant.
- **Rotation and retention:**
  - files rotate at `CLIPFORGE_LOG_MAX_FILE_MB` (default 5), keeping 4 rotated files per service;
  - at startup, files older than `CLIPFORGE_LOG_RETENTION_DAYS` (14) are deleted;
  - then the oldest files go until the directory is under `CLIPFORGE_LOG_MAX_DIR_MB` (100).
- **Redaction.** The session secret is replaced with `[REDACTED]` and the home directory with `~` before anything is written.
- **Find a job's history:** `grep '"jobId":"<id>"' <data>/logs/api.log`.

## Diagnostics

The **Diagnostics** screen shows:

- app version and mode, OS, and API/worker/database status;
- memory, CPU and disk, plus per-process memory and CPU (desktop, API tree, worker tree);
- job counts, log directory usage, and the last 50 warnings/errors.

**Export report** writes `<data>/diagnostics/clipforge-diagnostics-<ms>.json` (the 10 most recent are kept). It contains no credentials, file contents or media, and paths use `~`. Attach it to bug reports.

## Backups

- **Manual.** Diagnostics → Database → **Back up now**. This uses SQLite's online backup API (consistent while the app is running), then reopens the copy and runs `integrity_check`. A copy that fails verification is deleted and an error is shown.
- **Automatic.** Before applying new migrations to an existing database (that is, on app upgrade), a `pre-migration` backup is taken. The 5 most recent are kept.
- **Pruning.** Manual and `pre-restore` backups are never pruned automatically.

## Restore

1. Diagnostics → Database → choose a backup → **Restore…** → **Restore and restart API**.
2. The API verifies the backup (integrity, made by ClipForge, not from a newer app version) and stages it as `app.db.restore-pending`. The live database is untouched at this point.
3. On the next API start (the UI restarts it), the current database is preserved as a `pre-restore-…` backup. Only then is the staged file moved into place. A staged file that fails re-verification is set aside as `app.db.restore-rejected-<ms>` and the current database is kept.

Nothing is ever restored or reset automatically.

## Database corruption

At every start the API runs `PRAGMA quick_check`. If it fails, the API **refuses to start** with `code: "DB_CORRUPT"` in `api.log`, and Settings shows the API as failed. Nothing is modified. To recover:

1. Quit ClipForge.
2. Copy `<data>/data/` somewhere safe (including `-wal`/`-shm` files).
3. Move `app.db`, `app.db-wal` and `app.db-shm` out of `<data>/data/`, and copy the newest good file from `backups/` to `<data>/data/app.db`.
4. Start ClipForge; it migrates the restored copy if needed (taking a pre-migration backup first).

To check a file by hand: `sqlite3 <file> "pragma integrity_check;"`.

## Jobs

- **Durability.** Jobs live in the `jobs` table and survive restarts. On API start, jobs left `running` by a previous process are re-queued (`INTERRUPTED`), or failed if out of attempts.
- **Leases.** Running jobs heartbeat every 10 s with a 30 s lease. Expired leases are recovered on every scheduling pass (1 s).
- **Retries.** Failures are retried with exponential backoff and jitter (2 s base, 5 min cap) up to `maxAttempts`. Errors are stored as `{ code, message, retryable, at }`.
- **Limits:**
  - `CLIPFORGE_JOB_CONCURRENCY` (1–4, default 1) running jobs;
  - `CLIPFORGE_JOB_MAX_QUEUED` (default 500) queued jobs, beyond which new jobs get `429 QUEUE_FULL`.
- **Self-test.** Production Queue → **Run self-test job** exercises the whole path.

## Upgrades

1. Quit the app (services stop gracefully).
2. Install the new version.
3. On first start, the API takes a `pre-migration` backup if migrations are pending, then migrates.

To roll back to an older app version, restore its `pre-migration` backup. The restore procedure refuses backups from a _newer_ schema than the running app knows.

## CI

- `.github/workflows/ci.yml` runs on every PR and push to `main`:
  - install with the frozen lockfile;
  - typecheck, ESLint, Prettier;
  - Vitest and pytest;
  - production build;
  - Playwright (browser and mocked IPC);
  - `cargo fmt --check`, clippy `-D warnings` (Linux and Windows) and `cargo test` (Linux).
- `.github/workflows/security.yml` runs Gitleaks, Trivy, `pnpm audit` and `pip-audit` on PRs, `main`, and weekly. Policy: SECURITY.md.
- Artifacts: the Playwright report on failure, and the Trivy report always.

**Branch protection (configure in GitHub settings; it can't be set from the repo):** require the `CI` and `Security` checks and one approving review, and disallow force pushes to `main`.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm (pnpm lockfile), Cargo, pip, and GitHub Actions (monthly):

- minor and patch updates are grouped per ecosystem;
- major versions arrive as separate PRs;
- a 7-day cooldown skips brand-new releases;
- nothing auto-merges.

For each PR:

1. CI and Security must pass (branch protection).
2. Read the changelog. Major versions need a migration note in the PR, and an ADR if behaviour changes.
3. Check that the lockfile changed only as expected (`pnpm install --frozen-lockfile` passes in CI).
4. For runtime dependencies, also run the manual native checklist in RUNTIME_LIFECYCLE.md.

Manual upgrades follow the same rules. Justify any new dependency in the PR (license, maintenance, size).
