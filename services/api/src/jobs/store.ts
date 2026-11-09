import { and, asc, count, desc, eq, lt, lte, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@clipforge/database";
import { schema } from "@clipforge/database";
import {
  JOB_STATUSES,
  canTransition,
  type JobErrorInfo,
  type JobKind,
  type JobStatus,
  type JobView,
} from "@clipforge/shared";
import { HttpError } from "../errors.js";
import { retryDelayMs } from "./backoff.js";

const { jobs } = schema;
type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey?: string | undefined;
  readonly priority: number;
  readonly maxAttempts: number;
}

export interface ClaimedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
}

export interface FailureInput {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export class InvalidTransitionError extends HttpError {
  constructor(from: JobStatus, to: JobStatus) {
    super(409, "INVALID_TRANSITION", `Job cannot move from ${from} to ${to}`);
  }
}

function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Drizzle types `.get()` as always defined, but it is `undefined` when no row matched a guarded update. */
const maybe = <T>(row: T): T | undefined => row;

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

export function toView(row: JobRow): JobView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    progress: row.progress,
    cancelRequested: row.cancelRequested,
    idempotencyKey: row.idempotencyKey,
    error: row.error ?? null,
    runAfter: row.runAfter.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: ms(row.startedAt),
    finishedAt: ms(row.finishedAt),
  };
}

/**
 * Durable job queue on SQLite. Every state change is a single guarded UPDATE or an IMMEDIATE
 * transaction, so concurrent claimers (threads, processes, connections) can't double-execute a job.
 * Ownership is the lease: only the current `lease_owner` may heartbeat, complete or fail a job.
 */
export class JobStore {
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly db: AppDatabase,
    private readonly opts: {
      readonly maxQueued: number;
      readonly now?: () => number;
      readonly random?: () => number;
      /** Overrides the retry backoff (tests). */
      readonly retryDelay?: (attempt: number) => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.retryDelay = opts.retryDelay ?? ((attempt) => retryDelayMs(attempt, this.random));
  }

  private readonly retryDelay: (attempt: number) => number;

  /** Creates a job, or returns the existing one for a repeated idempotency key. */
  enqueue(input: EnqueueInput): { job: JobView; created: boolean } {
    return this.db.transaction(
      (tx) => {
        if (input.idempotencyKey) {
          const existing = tx
            .select()
            .from(jobs)
            .where(eq(jobs.idempotencyKey, input.idempotencyKey))
            .get();
          if (existing) {
            if (
              JSON.stringify([existing.kind, existing.payload]) !==
              JSON.stringify([input.kind, input.payload])
            ) {
              throw new HttpError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with a different request",
              );
            }
            return { job: toView(existing), created: false };
          }
        }
        // Backpressure instead of an unbounded queue.
        const queued = tx.select({ n: count() }).from(jobs).where(eq(jobs.status, "queued")).get();
        if ((queued?.n ?? 0) >= this.opts.maxQueued) {
          throw new HttpError(429, "QUEUE_FULL", "Too many queued jobs; try again later");
        }
        const now = new Date(this.now());
        const row = tx
          .insert(jobs)
          .values({
            kind: input.kind,
            payload: input.payload,
            idempotencyKey: input.idempotencyKey ?? null,
            priority: input.priority,
            maxAttempts: input.maxAttempts,
            runAfter: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        return { job: toView(row), created: true };
      },
      { behavior: "immediate" },
    );
  }

  /** Atomically claims the next runnable job, honoring the global running-job limit. */
  claim(owner: string, leaseMs: number, concurrency: number): ClaimedJob | null {
    return this.db.transaction(
      (tx) => {
        const running = tx
          .select({ n: count() })
          .from(jobs)
          .where(eq(jobs.status, "running"))
          .get();
        if ((running?.n ?? 0) >= concurrency) return null;
        const now = this.now();
        const next = tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, new Date(now))))
          .orderBy(desc(jobs.priority), asc(jobs.createdAt))
          .limit(1)
          .get();
        if (!next) return null;
        assertTransition("queued", "running");
        const row = maybe(
          tx
            .update(jobs)
            .set({
              status: "running",
              attempt: sql`${jobs.attempt} + 1`,
              leaseOwner: owner,
              leaseExpiresAt: new Date(now + leaseMs),
              heartbeatAt: new Date(now),
              startedAt: sql`coalesce(${jobs.startedAt}, ${now})`,
            })
            .where(and(eq(jobs.id, next.id), eq(jobs.status, "queued")))
            .returning()
            .get(),
        );
        if (!row) return null;
        return { id: row.id, kind: row.kind, payload: row.payload, attempt: row.attempt };
      },
      { behavior: "immediate" },
    );
  }

  /** Extends the lease (and records progress). `null` means the lease was lost: stop working. */
  heartbeat(
    id: string,
    owner: string,
    leaseMs: number,
    progress?: number,
  ): { cancelRequested: boolean } | null {
    const now = this.now();
    const row = maybe(
      this.db
        .update(jobs)
        .set({
          leaseExpiresAt: new Date(now + leaseMs),
          heartbeatAt: new Date(now),
          ...(progress !== undefined && { progress: Math.min(1, Math.max(0, progress)) }),
        })
        .where(this.owned(id, owner))
        .returning({ cancelRequested: jobs.cancelRequested })
        .get(),
    );
    return row ?? null;
  }

  succeed(id: string, owner: string, result: Record<string, unknown> | undefined): boolean {
    assertTransition("running", "succeeded");
    const now = new Date(this.now());
    return this.finishOwned(id, owner, {
      status: "succeeded",
      progress: 1,
      result: result ?? null,
      error: null,
      finishedAt: now,
    });
  }

  /** Records a failure; schedules a retry with backoff while attempts remain. */
  fail(id: string, owner: string, failure: FailureInput): JobStatus | null {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(jobs).where(this.owned(id, owner)).get();
        if (!row) return null;
        const status = this.failureOutcome(row, failure.retryable);
        assertTransition("running", status);
        const now = this.now();
        tx.update(jobs)
          .set({
            status,
            error: this.errorInfo(failure, now),
            leaseOwner: null,
            leaseExpiresAt: null,
            ...(status === "queued"
              ? { runAfter: new Date(now + this.retryDelay(row.attempt)) }
              : { finishedAt: new Date(now) }),
          })
          .where(this.owned(id, owner))
          .run();
        return status;
      },
      { behavior: "immediate" },
    );
  }

  /** The runner acknowledges a cancellation request after stopping the work. */
  markCancelled(id: string, owner: string): boolean {
    assertTransition("running", "cancelled");
    return this.finishOwned(id, owner, { status: "cancelled", finishedAt: new Date(this.now()) });
  }

  /** Returns a job to the queue without consuming an attempt (graceful shutdown). */
  release(id: string, owner: string): boolean {
    assertTransition("running", "queued");
    return this.finishOwned(id, owner, {
      status: "queued",
      attempt: sql`max(0, ${jobs.attempt} - 1)`,
    });
  }

  /** Queued jobs are cancelled immediately; running jobs are flagged and stopped by their runner. */
  requestCancel(id: string): JobView | null {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(jobs).where(eq(jobs.id, id)).get();
        if (!row) return null;
        if (row.status === "running") {
          const flagged = maybe(
            tx.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id)).returning().get(),
          );
          return toView(flagged ?? row);
        }
        assertTransition(row.status, "cancelled");
        const updated = maybe(
          tx
            .update(jobs)
            .set({ status: "cancelled", cancelRequested: true, finishedAt: new Date(this.now()) })
            .where(and(eq(jobs.id, id), eq(jobs.status, row.status)))
            .returning()
            .get(),
        );
        return toView(updated ?? row);
      },
      { behavior: "immediate" },
    );
  }

  /** Running jobs whose lease ran out (hung or crashed runner) are retried or failed. */
  recoverExpired(): number {
    return this.recover(
      and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, new Date(this.now()))),
      "LEASE_EXPIRED",
      "The job stopped sending heartbeats",
    );
  }

  /**
   * Startup recovery. The API is the only runner (ADR-011), so any job still `running` when it
   * starts belongs to a previous process that crashed or was killed.
   */
  recoverInterrupted(): number {
    return this.recover(
      eq(jobs.status, "running"),
      "INTERRUPTED",
      "The app stopped while the job was running",
    );
  }

  get(id: string): JobView | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toView(row) : null;
  }

  list(status: JobStatus | undefined, limit: number): JobView[] {
    return this.db
      .select()
      .from(jobs)
      .where(status ? eq(jobs.status, status) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .all()
      .map(toView);
  }

  counts(): Record<JobStatus, number> {
    const result = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const row of this.db
      .select({ status: jobs.status, n: count() })
      .from(jobs)
      .groupBy(jobs.status)
      .all()) {
      result[row.status] = row.n;
    }
    return result;
  }

  private recover(where: ReturnType<typeof and>, code: string, message: string): number {
    return this.db.transaction(
      (tx) => {
        const rows = tx.select().from(jobs).where(where).all();
        const now = this.now();
        for (const row of rows) {
          const status: JobStatus = row.cancelRequested
            ? "cancelled"
            : this.failureOutcome(row, true);
          assertTransition("running", status);
          tx.update(jobs)
            .set({
              status,
              error: this.errorInfo({ code, message, retryable: status === "queued" }, now),
              leaseOwner: null,
              leaseExpiresAt: null,
              ...(status === "queued"
                ? { runAfter: new Date(now + this.retryDelay(row.attempt)) }
                : { finishedAt: new Date(now) }),
            })
            .where(and(eq(jobs.id, row.id), eq(jobs.status, "running")))
            .run();
        }
        return rows.length;
      },
      { behavior: "immediate" },
    );
  }

  private failureOutcome(row: JobRow, retryable: boolean): "queued" | "failed" {
    return retryable && row.attempt < row.maxAttempts ? "queued" : "failed";
  }

  private errorInfo(f: FailureInput, now: number): JobErrorInfo {
    // Messages are capped: they are diagnostics, not a place for unbounded payloads.
    return { code: f.code, message: f.message.slice(0, 500), retryable: f.retryable, at: now };
  }

  private owned(id: string, owner: string) {
    return and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.leaseOwner, owner));
  }

  private finishOwned(id: string, owner: string, set: SQLiteUpdateSetSource<typeof jobs>): boolean {
    const row = maybe(
      this.db
        .update(jobs)
        .set({ leaseOwner: null, leaseExpiresAt: null, ...set })
        .where(this.owned(id, owner))
        .returning({ id: jobs.id })
        .get(),
    );
    return row !== undefined;
  }
}
