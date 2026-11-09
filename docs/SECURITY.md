# Security

Threat model, controls, the Phase 2 audit, and the CI severity policy. Passing checks do not make the app secure. This document lists what is and isn't defended.

## Threat model

ClipForge Local runs entirely on the user's machine. Assets: the user's database (channels, scripts, rights records), future OAuth tokens (OS keychain), media files, and the ability to make the app take actions (jobs, uploads in later phases).

| Actor                                                                          | In scope | Main controls                                                                                                                                        |
| ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web pages in any browser (CSRF, DNS rebinding, port scanning)                  | Yes      | Loopback bind, Host allowlist, browser-header rejection, request signing                                                                             |
| Other OS user accounts on the same machine                                     | Yes      | Request signing (secret not visible to other users), data dirs `0700`                                                                                |
| Sandboxed / low-privilege local apps that can open loopback sockets            | Yes      | Request signing                                                                                                                                      |
| Malicious content loaded into the webview (future: rendered scripts, metadata) | Partly   | Strict CSP (no remote scripts, no network to services), explicit Tauri command permissions, server-side validation                                   |
| Malware running as the same OS user                                            | **No**   | It can read the SQLite file, attach debuggers or read process environments. Out of scope for an unsandboxed desktop app; noted where it matters (M1) |
| Network attackers                                                              | Yes      | Nothing listens on non-loopback interfaces (validated at startup in API and worker)                                                                  |

## Controls

### API session authentication (ADR-010)

- **Secret.** The Rust runtime generates 32 bytes from the OS CSPRNG (`getrandom`) on every launch, so restarting the app rotates it. The secret is never written to disk or SQLite, never logged (the runtime redacts it from all captured output), and never given to the webview.
- **Signing.** Every API request is signed: `HMAC-SHA256(secret, "CFL1\n" + METHOD + "\n" + path?query + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body))`. Headers: `x-clipforge-timestamp`, `x-clipforge-nonce`, `x-clipforge-signature`.
- **The API rejects:**
  - missing or malformed headers;
  - timestamps outside ±30 s (expired or future);
  - wrong signatures (constant-time comparison, `timingSafeEqual`);
  - reused nonces (bounded replay cache, 60 s TTL, 10 000 entries; when saturated it returns 429 rather than evicting);
  - any change to method, path, query or body.
- **Failure responses** are always `401 {"code":"UNAUTHORIZED","message":"Authentication required"}`. The specific reason only goes to the API log.
- **Exemption.** Only `GET /health` is exempt. It returns `{"status":"ok","service":"api"}` and nothing else. Unknown routes require authentication before they 404, so routes can't be enumerated.
- **Cross-origin.** There is no CORS. Requests carrying `Origin` or any `Sec-Fetch-*` header get 403, because browsers always send these and the Rust client never does. The webview CSP no longer allows connecting to the API at all.
- **Limits.** Body limit 256 KiB, request timeout 30 s, correlation ids accepted only as `[A-Za-z0-9-]{8,64}`.
- **Tests.** `services/api/src/auth.test.ts` covers missing, invalid, expired, future, valid, replay, rotation, tampering, path-trick bypasses and cross-origin. A shared test vector keeps the Rust and TypeScript signers byte-compatible.

### Desktop runtime

- **Tauri commands.** The app commands are declared in `build.rs` and granted one by one in `capabilities/default.json` (no implicit allow-all). No shell, fs or http plugins.
- **`api_request` proxy.** Allowed methods are `GET`, `POST`, `PATCH`, `DELETE`. Paths must start with `/api/v1/`, use a restricted character set (no `..`, `//`, `#`, CR/LF or backslash) and be at most 512 bytes. The host is fixed to `127.0.0.1:<api port>`, so there is no SSRF surface. Requests are capped at 256 KiB and responses at 4 MiB. The HTTP client ignores proxy environment variables and does not follow redirects.
- **Process commands** (`worker_start`, `worker_stop`, `api_restart`) take no arguments: the frontend cannot influence programs, arguments or environment.
- **Children:**
  - argument arrays only;
  - executables validated (exists, is a file);
  - production sidecars must resolve inside the app directory (symlink escape rejected);
  - allowlisted environment;
  - own process group;
  - tree kill on stop.

### Data

- **Location and permissions.** The database, backups, logs and diagnostics live in the OS user-data directory, created owner-only (`0700`) on Unix.
- **Backups.** Backup and restore ids are matched against `^[a-z0-9-]{1,100}\.db$` and resolved inside the backups directory only (traversal tested).
- **Diagnostics export.** No secrets, tokens, file contents or media. The home directory is replaced with `~`, and the whole document is redacted again before writing.

## Phase 2 audit findings

### Critical

None found.

### High — fixed in Phase 2

| ID  | Finding                                                                                                                                                             | Fix                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| H1  | API had no authentication; any local process (and any web page, for non-preflighted requests) could call it. Blocking for state-changing endpoints.                 | Per-launch HMAC request signing (above)                           |
| H2  | Webview CSP allowed `connect-src http://127.0.0.1:4317`: any script running in the webview could talk to the API directly, so a token would have had to live in JS. | API removed from CSP; Rust proxy holds the secret                 |
| H3  | No process ownership: API and worker were started by hand, and nothing prevented orphans or duplicates.                                                             | Service manager, parent watchdogs, port check, process-group kill |

### Medium

| ID  | Finding                                                                                                                                                         | Status                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | The secret reaches the API through an environment variable, which same-user tools can read (`ps -E` on macOS, verified). Other users can't.                     | **Accepted for Phase 2** (same-user malware is out of scope; it can read the DB directly). Plan: stdin handoff for production sidecars. |
| M2  | The worker has no authentication. Today it exposes only `/health`.                                                                                              | **Open — gate:** the worker must verify signed requests (same scheme, separate secret) before any endpoint beyond `/health` is added.   |
| M3  | Windows: no Job Object, so if the desktop process crashes the Python worker survives (its parent watchdog is POSIX-only). The API still exits via its watchdog. | Open — required before Windows release (RUNTIME_LIFECYCLE.md).                                                                          |
| M4  | Tauri app commands were implicitly available to all windows.                                                                                                    | **Fixed:** explicit app manifest and per-command permissions.                                                                           |

### Low

| ID  | Finding                                                                                                                                                                                      | Status                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| L1  | Port squatting: a process that binds 4317 first and answers 200 to everything would pass the readiness probe. Signatures are single-use, so no credential leaks, but UI data would go to it. | Open (same-user attacker). Fix: API signs responses (mutual auth). |
| L2  | The secret is not zeroized in memory after use.                                                                                                                                              | Accepted                                                           |
| L3  | PID reuse could delay the parent watchdog noticing a dead parent.                                                                                                                            | Accepted (the desktop kills children explicitly on normal exit)    |
| L4  | `style-src 'unsafe-inline'` in CSP (Tailwind/shadcn runtime styles).                                                                                                                         | Accepted; no inline scripts allowed                                |
| L5  | `pnpm audit`: moderate esbuild advisory (dev server, via drizzle-kit) and moderate minimatch ReDoS, both dev-only tooling; one low with no fix.                                              | Tracked by Dependabot; below the CI gate                           |
| L6  | Data directories were created with the default umask (0755).                                                                                                                                 | **Fixed:** `0700`                                                  |

### Reviewed, no issue

- **SSRF.** No outbound network calls; the proxy host is fixed.
- **SQL.** Drizzle query builder only, no interpolation.
- **Path traversal.** Backup ids are validated and tested.
- **Logs.** pino redacts auth headers, and the Rust capture redacts the secret and home path.
- **Worker communication.** Loopback only, health checks only.

## CI severity policy

| Tool                            | Scope                              | Fails the build when                                                                                    |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Gitleaks                        | Full git history on every PR/push  | Any finding                                                                                             |
| Trivy (fs, `vuln`)              | `pnpm-lock.yaml`, `Cargo.lock`     | **HIGH or CRITICAL with a fix available**. All severities go to the `trivy-report` artifact for triage. |
| `pnpm audit --audit-level high` | npm dependencies                   | HIGH or CRITICAL                                                                                        |
| `pip-audit --strict`            | `services/worker/requirements.txt` | Any known vulnerability                                                                                 |

- **Medium and low findings** are reviewed weekly via the scheduled run and Dependabot. They don't block merges.
- **Unfixable HIGH findings** need a written exception: a Trivy ignore entry with justification and expiry, plus a row in this document.
- **Action pinning.** Workflows pin actions by commit SHA and the Trivy binary by version (trivy-action tags were hijacked in 2026, so floating tags are not trusted).
- **Workflow security.** Workflows use `pull_request` (never `pull_request_target`), `contents: read` and `persist-credentials: false`.

## Reporting

Private project. Report vulnerabilities to the maintainer directly, not in public issues.
