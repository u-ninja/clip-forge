# Engineering Standards

Project: ClipForge Local. Local-first AI video production desktop app.

These rules are **mandatory** for every app, service, package and future integration in this repository. "Must" and "never" are not suggestions. If a rule blocks you, raise it and record an ADR; do not quietly work around it.

## 0. Principle

- Enterprise-grade means clear boundaries, predictable behavior, security, observability, resource limits, maintainability and testability — NOT added complexity.
- Choose the simplest design that satisfies requirements without compromising security, correctness or maintainability.
- Don't overengineer. Don't abstract for hypothetical futures. Don't duplicate substantial logic either.

Stack reference: Tauri 2 + Rust + React/Vite/TS (`apps/desktop`), Fastify TS API on 127.0.0.1 (`services/api`), Python FastAPI worker (`services/worker`), SQLite + Drizzle (`packages/database`), shared Zod schemas/types (`packages/shared`). Targets: MacBook Air M2 16 GB (Metal), Windows Ryzen + RTX 3070 Ti 8 GB (CUDA).

Data flow: React UI -> Tauri IPC (Rust runtime signs requests) -> Fastify -> Database / Python Worker. The UI has no direct network access to local services.

## 1. Architecture and separation of concerns

- Apply SOLID where it reduces coupling; do not apply it ceremonially.
- Keep business logic, infrastructure, presentation and integrations in separate modules.
- Put every external integration (DB, AI providers, OS, FFmpeg, YouTube) behind an interface/adapter.
- No circular dependencies between modules or packages.
- No giant files or components; split by responsibility.
- Prefer composition over inheritance.
- Use dependency injection where it makes code testable; not everywhere.
- No premature microservices. The API, worker and desktop app are the only processes until an ADR says otherwise.
- Every module has: a clear single responsibility, an explicit public interface, controlled dependencies, and unit tests for its important logic.

## 2. Reuse and maintainability

- No duplicated business logic.
- Extract to `packages/shared` only on genuine reuse (two or more real consumers).
- Centralize configuration. No magic numbers or strings: use named constants and discriminated unions.
- Small, focused functions. Shallow nesting; return early.
- Never duplicate state; derive it.
- Keep API contracts consistent across endpoints (naming, envelopes, pagination, errors).

## 3. TypeScript

- `strict` mode everywhere.
- No `any`. Use `unknown`, then validate/narrow.
- No unsafe type assertions or non-null `!` unless an invariant guarantees it; comment the invariant.
- Model workflow states as discriminated unions.
- Explicit return types on public functions and service boundaries.
- Validate all external input at runtime with Zod (HTTP, IPC, files, env, worker responses, third-party APIs).
- Share schemas from `packages/shared`; infer types from schemas, don't hand-duplicate them.
- The backend never trusts frontend types; it re-validates.
- Prefer `readonly` and immutable data.

## 4. Memory and resource management

General:

- Define a memory budget per process (desktop, API, worker).
- Never load whole videos into memory. Stream/chunk via FFmpeg; use file-backed temp storage.
- Release native handles, file descriptors, child processes, event listeners and timers deterministically.
- Caches are bounded with an eviction policy.
- Paginate list endpoints; virtualize long lists in the UI.

AI models:

- One large model loaded at a time by default.
- A model lifecycle manager owns load / unload / availability.
- RAM and VRAM limits are configurable.
- Under resource constraint, execute sequentially.
- Jobs have priorities and concurrency limits.
- Expose a quality-vs-performance setting.
- Detect hardware at runtime; support CPU, Metal and CUDA backends with graceful fallback. Never assume a GPU.

Processing limits:

- Max input size and duration per profile.
- Job timeouts and retry limits.
- Cap concurrent FFmpeg processes and Python workers.
- Apply backpressure instead of unbounded queuing.
- Cancellation kills child processes (and their trees).

Performance budgets (track; measure, don't assume):

- Startup time, idle and peak memory, CPU/GPU utilization, processing throughput, API latency, queue wait, DB query time.

Process policy:

- The API starts with the desktop app; Ollama and the worker never auto-start (worker: explicit request only).
- No Docker or Redis requirement.

## 5. Security

General:

- Least privilege everywhere.
- Strict Tauri capabilities; no shell execution from the frontend.
- Validate and sanitize filenames and paths. Prevent path traversal and symlink attacks. Restrict file access to app-owned storage directories.
- Spawn processes with argument arrays. Never build shell strings from untrusted input.
- Bind services to loopback only. Restrict CORS to known origins.
- Localhost is not authentication. Every API route except `GET /health` requires a signed request (ADR-010); new routes get this automatically and must not opt out.
- Session credentials live only in the Rust runtime and the API process memory. Never pass them to the webview, never log or persist them.
- Only the desktop runtime spawns service processes (ADR-012). New Tauri commands must not accept programs, arguments, paths or environment from the frontend, and each command needs an explicit permission in `capabilities/`.
- IPC contracts are explicit and validated on both sides.

Secrets:

- Never commit or log secrets.
- OAuth refresh tokens live only in macOS Keychain / Windows Credential Manager, via a credential-store abstraction.
- Redact credentials in errors and logs.
- Env vars are for dev and non-secret config only.
- Never expose backend secrets via `VITE_` variables.

Media:

- Treat imported media, metadata and scripts as untrusted.
- Verify actual format (magic bytes / ffprobe), not extension or MIME alone.
- Use isolated temp directories with safe cleanup.
- Enforce limits against decompression bombs and malformed media.
- Validate downloads (size, type, integrity where available).

Network:

- HTTPS for all external integrations.
- Timeouts on every outbound request.
- Validate responses with schemas.
- SSRF protection: restrict URL schemes and destinations.
- Request size limits; rate limiting where relevant.
- Validate OAuth `state`.

Dependencies:

- Use reputable, maintained packages; justify each new dependency.
- Check licenses; keep a dependency/license register.
- Lockfile committed and pinned.
- Regular audits; controlled, deliberate upgrades.

## 6. Database (SQLite + Drizzle)

- Every schema change ships with a migration (`pnpm db:generate` / drizzle-kit generate). Never hand-edit an applied migration.
- Use transactions for multi-step operations; keep them short.
- Foreign keys on. Use constraints. Add indexes from real query patterns.
- No N+1 queries.
- Parameterized queries only; never interpolate input into SQL.
- WAL mode and `busy_timeout` set at connection.
- The API is the single owning process for writes. Connection lifecycle is controlled (open once, close on shutdown).
- Provide backup/restore and retention/cleanup policies.
- Upgrades are safe; never silently discard user data.
- The DB file lives in the OS user-data directory, never in the repo.

## 7. API and inter-service

- Versioned contracts (`/api/v1/...` once stable).
- Validate request and response schemas.
- Consistent response and error envelope.
- Correct HTTP status codes.
- Centralized error handler; never leak internals (stack traces, SQL, paths) to clients.
- Request timeouts and body size limits.
- Graceful shutdown: stop accepting, drain, close DB, stop children.
- Long-running work is async and returns a job ID.
- Retryable operations are idempotent.
- Propagate correlation IDs (`x-request-id`) across API <-> worker.
- Document every contract.
- The frontend never touches the DB or worker internals.

## 8. Jobs and reliability

- Job state is durable and persisted. Never in-memory-only queues.
- Explicit job states and legal transitions (state machine, discriminated unions). Reject illegal transitions.
- Jobs resume after restart. On startup, recover interrupted jobs and clean orphaned processes.
- Stages are independently executable with persisted outputs/checkpoints.
- Retry with exponential backoff + jitter. Classify failures as retryable vs permanent. Cap retries.
- Support cancellation.
- Deduplicate via idempotency keys.
- Track progress and per-stage durations.
- Jobs are independent of the UI lifecycle.
- Never mark success before the output is verified (exists, valid, expected duration/format).

## 9. Error handling

- No swallowed exceptions; no empty `catch`.
- Model expected errors explicitly.
- Separate user-facing messages from diagnostics.
- Messages are actionable (what happened, what to do).
- Preserve causes: `new Error(msg, { cause })`.
- Use typed errors where they aid handling.
- Degrade gracefully for missing files, models, memory and external APIs.
- Partial failures must not corrupt completed work.

## 10. Logging and observability

- Structured JSON logs: pino in Fastify, structured logging in Python.
- Fields: `timestamp`, `level`, `service`, `jobId`, `correlationId`, `operation`, `duration`, `error`.
- Levels: `debug`, `info`, `warn`, `error`. Use them consistently.
- Redact secrets and PII.
- Log rotation; bounded growth on disk.
- Record stage durations, failures and retries.
- Plan a diagnostics screen in the app.
- Goal: explain any job failure without a debugger.

## 11. Testing

Pyramid:

- Unit: business logic, validation, workflow transitions, rights verification, resource allocation.
- Integration: DB with temp databases, API endpoints via `fastify.inject`, worker communication, storage, job persistence and recovery.
- E2E (Playwright): UI workflows in a browser against mocked IPC. These do not prove native behaviour; native lifecycle is covered by `cargo test` and the manual checklist in RUNTIME_LIFECYCLE.md. Never describe browser E2E as native coverage.

Rules:

- Test failure paths, cancellation, duplicate execution, insufficient resources, corrupted media and migration paths.
- Mock external services. Tests never require real credentials.
- Write meaningful tests, not coverage padding.

## 12. Frontend

- Small reusable components (shadcn/ui + Tailwind tokens).
- Separate UI state from server state. Keep global state minimal.
- Semantic, accessible HTML; full keyboard navigation.
- Every data view handles loading, empty, success and error states.
- Prevent duplicate actions (disable/guard while pending).
- Optimistic updates only when safe to roll back.
- Never block the UI on long work; use jobs and progress.
- Virtualize large lists. Avoid needless re-renders.
- Centralized design tokens.
- Mock data is clearly separated from real state.
- No business-critical workflow logic in the frontend.

## 13. Accessibility and i18n

- Labels on all controls; keyboard access; sufficient contrast.
- Never convey state by color alone.
- Strings are localization-ready (no concatenated sentences).
- Use `Intl` for dates and numbers.
- Prepare for multilingual content and narration.

## 14. Configuration

- Centralized, Zod-validated at startup; fail fast on invalid config.
- Sensible defaults.
- Separate dev / test / prod.
- No hardcoded absolute paths.
- Platform-specific storage locations via OS APIs.
- Document every variable in `.env.example`. Never commit a real `.env`.

## 15. Cross-platform

- No platform assumptions in business logic.
- Platform adapters for OS capabilities: paths, credential store, GPU, encoders.
- Use path APIs, never string concatenation.
- Handle process lifecycle differences (e.g. no POSIX signals on Windows; kill process trees explicitly).
- Detect available encoders/decoders at runtime.
- Test macOS and Windows separately.
- Document any platform workaround in shared code at the point of use.

## 16. Documentation and ADRs

Maintain:

- Architecture overview (`docs/ARCHITECTURE.md`) and module responsibility map.
- DB schema docs, API contracts, security model, resource strategy.
- Install/dev guide (`docs/DEVELOPMENT.md`), troubleshooting.
- Dependency/license register, backup/recovery procedure.

ADRs:

- Every significant decision gets an ADR in `docs/DECISIONS.md` with: Context, Decision, Alternatives, Consequences, Trade-offs.

## 17. Code review and change management

Before completing a change, review:

- Affected architecture and boundaries.
- Duplication.
- Security.
- Resource use.
- Error handling.
- Meaningful tests.
- Docs.
- Backward compatibility.
- Migrations.

Avoid:

- Unrelated refactors.
- Unjustified dependencies.
- Massive, unexplained changes.
- NEVER disable tests or lint rules to make a build pass.

## 18. Definition of Done

- [ ] Functional requirements met
- [ ] Boundaries respected
- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Tests pass (`pnpm test`, `cargo test`, `pnpm --filter @clipforge/desktop test:e2e`)
- [ ] Rust checks pass (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`)
- [ ] Error handling done
- [ ] Security reviewed
- [ ] Resource use reasonable
- [ ] No secrets exposed
- [ ] Docs updated
- [ ] Migrations included (if schema changed)
- [ ] Cross-platform considered
- [ ] No regressions

Report any incomplete item explicitly. Never claim a check passed that was not run.

## 19. Decision rule

Evaluate options against: correctness, security, reliability, maintainability, reusability, performance, memory/CPU, cross-platform, testability, operational complexity, dependency/licensing.

Pick the simplest design that meets the requirements.

## 20. Automated enforcement

Rules that are only written down are not enforced. Prefer turning a rule into a check.

| Tool               | Enforces                                | Status               |
| ------------------ | --------------------------------------- | -------------------- |
| ESLint             | Code rules, no `any`, import boundaries | Phase 1 (configured) |
| Prettier           | Formatting                              | Phase 1 (configured) |
| TypeScript strict  | Type safety                             | Phase 1 (configured) |
| Vitest             | Unit and integration tests              | Phase 1 (configured) |
| Zod                | Runtime validation of external input    | Phase 1 (configured) |
| Drizzle Kit        | Schema migrations                       | Phase 1 (configured) |
| Playwright         | Browser E2E (mocked IPC)                | Phase 2 (configured) |
| Dependabot         | Controlled dependency upgrades          | Phase 2 (configured) |
| Gitleaks           | Secret scanning                         | Phase 2 (configured) |
| Trivy / audits     | Dependency and vulnerability scanning   | Phase 2 (configured) |
| GitHub Actions     | CI running all of the above             | Phase 2 (configured) |
| rustfmt / clippy   | Rust formatting and lints               | Phase 2 (configured) |
| Tauri app manifest | Explicit per-command IPC permissions    | Phase 2 (configured) |

## Core principle

Build a maintainable, secure, resource-conscious product that can grow from a single developer's local desktop app into a professionally engineered multi-platform product.
