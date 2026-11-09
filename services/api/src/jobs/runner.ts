import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { JobKind } from "@clipforge/shared";
import { JobFailure, type JobHandler } from "./handlers.js";
import type { ClaimedJob, JobStore } from "./store.js";

type StopReason = "cancel" | "lease-lost" | "timeout" | "shutdown";

class Stop {
  constructor(readonly reason: StopReason) {}
}

export interface RunnerOptions {
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly pollMs: number;
}

export const DEFAULT_RUNNER_OPTIONS: Omit<RunnerOptions, "concurrency"> = {
  leaseMs: 30_000,
  pollMs: 1_000,
};

/**
 * In-process executor. Claims jobs from the durable store up to `concurrency`, heartbeats their
 * leases, and maps every outcome (success, failure, cancel, timeout, lost lease) to a persisted state.
 * In-memory state here is only a cache of what this process is executing; SQLite is the truth.
 */
export class JobRunner {
  readonly owner = `api-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: JobStore,
    private readonly handlers: Readonly<Record<JobKind, JobHandler>>,
    private readonly opts: RunnerOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get concurrency(): number {
    return this.opts.concurrency;
  }

  start(): void {
    const recovered = this.store.recoverInterrupted();
    if (recovered > 0)
      this.log.warn({ recovered, operation: "jobs.recover" }, "recovered interrupted jobs");
    this.running = true;
    this.kick();
  }

  /** Schedules an immediate claim pass (e.g. after enqueue). */
  kick(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick();
    }, 0);
  }

  /** Stops claiming, aborts active work and returns it to the queue. */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    for (const { controller } of this.active.values()) controller.abort(new Stop("shutdown"));
    const all = Promise.all([...this.active.values()].map((a) => a.done));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  private tick(): void {
    if (!this.running) return;
    try {
      const expired = this.store.recoverExpired();
      if (expired > 0)
        this.log.warn({ expired, operation: "jobs.recover" }, "requeued jobs with expired leases");
      while (this.active.size < this.opts.concurrency) {
        const job = this.store.claim(this.owner, this.opts.leaseMs, this.opts.concurrency);
        if (!job) break;
        const controller = new AbortController();
        const done = this.execute(job, controller);
        this.active.set(job.id, { controller, done });
      }
    } catch (err) {
      this.log.error({ err, operation: "jobs.tick" }, "job scheduling pass failed");
    }
    this.timer = setTimeout(() => {
      this.tick();
    }, this.opts.pollMs);
  }

  private async execute(job: ClaimedJob, controller: AbortController): Promise<void> {
    const log = this.log.child({ jobId: job.id, kind: job.kind, attempt: job.attempt });
    const started = Date.now();
    const handler = this.handlers[job.kind];
    const { signal } = controller;
    const stopWith = (reason: StopReason) => {
      if (!signal.aborted) controller.abort(new Stop(reason));
    };
    const beat = (progress?: number) => {
      const res = this.store.heartbeat(job.id, this.owner, this.opts.leaseMs, progress);
      if (!res) stopWith("lease-lost");
      else if (res.cancelRequested) stopWith("cancel");
    };
    const heartbeat = setInterval(() => {
      beat();
    }, this.opts.leaseMs / 3);
    const timeout = setTimeout(() => {
      stopWith("timeout");
    }, handler.timeoutMs);
    log.info({ operation: "job.start" }, "job started");

    try {
      const result = await handler.run(job.payload, {
        jobId: job.id,
        attempt: job.attempt,
        signal,
        reportProgress: (p) => {
          beat(p);
        },
        log,
      });
      if (signal.aborted) throw signal.reason;
      this.store.succeed(job.id, this.owner, result);
      log.info({ operation: "job.succeed", duration: Date.now() - started }, "job succeeded");
    } catch (err) {
      this.settleFailure(job, err, signal, log, Date.now() - started);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.active.delete(job.id);
      this.kick();
    }
  }

  private settleFailure(
    job: ClaimedJob,
    err: unknown,
    signal: AbortSignal,
    log: FastifyBaseLogger,
    duration: number,
  ): void {
    const reason = signal.reason instanceof Stop ? signal.reason.reason : undefined;
    switch (reason) {
      case "cancel":
        this.store.markCancelled(job.id, this.owner);
        log.info({ operation: "job.cancel", duration }, "job cancelled");
        return;
      case "lease-lost":
        // Another owner (or recovery) has the job now; writing anything would clobber its state.
        log.warn({ operation: "job.lease-lost", duration }, "job lease lost; result discarded");
        return;
      case "shutdown":
        this.store.release(job.id, this.owner);
        log.info({ operation: "job.release", duration }, "job returned to queue for shutdown");
        return;
      case "timeout": {
        const status = this.store.fail(job.id, this.owner, {
          code: "TIMEOUT",
          message: "The job exceeded its time limit",
          retryable: true,
        });
        log.warn({ operation: "job.fail", duration, status, error: "TIMEOUT" }, "job timed out");
        return;
      }
      case undefined: {
        const failure =
          err instanceof JobFailure
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : {
                code: "UNEXPECTED",
                message: err instanceof Error ? err.message : String(err),
                retryable: true,
              };
        const status = this.store.fail(job.id, this.owner, failure);
        log.warn(
          { operation: "job.fail", duration, status, error: failure.code, err },
          "job failed",
        );
      }
    }
  }
}
