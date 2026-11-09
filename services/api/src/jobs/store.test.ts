import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@clipforge/database";
import { retryDelayMs, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from "./backoff.js";
import { JobStore, type EnqueueInput } from "./store.js";
import { tempDatabase, type TestDb } from "../test-support.js";

const LEASE = 30_000;
const selftest = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  kind: "system.selftest",
  payload: {},
  priority: 0,
  maxAttempts: 3,
  ...over,
});

describe("JobStore", () => {
  let db: TestDb;
  let clock: number;
  let store: JobStore;

  beforeEach(() => {
    db = tempDatabase();
    clock = 1_700_000_000_000;
    store = new JobStore(db.handle.db, { maxQueued: 5, now: () => clock, retryDelay: () => 1_000 });
  });
  afterEach(() => {
    db.cleanup();
  });

  it("persists jobs and runs the happy path", () => {
    const { job } = store.enqueue(selftest());
    expect(job.status).toBe("queued");
    const claimed = store.claim("w1", LEASE, 1);
    expect(claimed).toMatchObject({ id: job.id, attempt: 1 });
    expect(store.heartbeat(job.id, "w1", LEASE, 0.5)).toEqual({ cancelRequested: false });
    expect(store.get(job.id)?.progress).toBe(0.5);
    expect(store.succeed(job.id, "w1", { ok: true })).toBe(true);
    expect(store.get(job.id)).toMatchObject({ status: "succeeded", progress: 1 });
  });

  it("survives an application restart (new connection, same file)", () => {
    const { job } = store.enqueue(selftest());
    db.handle.close();
    const reopened = openDatabase(db.path);
    try {
      const again = new JobStore(reopened.db, { maxQueued: 5 });
      expect(again.get(job.id)?.status).toBe("queued");
    } finally {
      reopened.close();
      Object.assign(db, { handle: openDatabase(db.path) });
    }
  });

  it("is idempotent per key and rejects a conflicting reuse", () => {
    const a = store.enqueue(selftest({ idempotencyKey: "render-abc-123" }));
    const b = store.enqueue(selftest({ idempotencyKey: "render-abc-123" }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ job: a.job, created: false });
    expect(() =>
      store.enqueue(selftest({ idempotencyKey: "render-abc-123", payload: { durationMs: 1 } })),
    ).toThrow(/different request/);
    expect(store.list(undefined, 10)).toHaveLength(1);
  });

  it("applies backpressure instead of queueing without bound", () => {
    for (let i = 0; i < 5; i++) store.enqueue(selftest());
    expect(() => store.enqueue(selftest())).toThrow(/Too many queued jobs/);
  });

  it("never hands the same job to two claimers and honors the concurrency limit", () => {
    const { job } = store.enqueue(selftest());
    store.enqueue(selftest());
    expect(store.claim("w1", LEASE, 1)?.id).toBe(job.id);
    expect(store.claim("w2", LEASE, 1)).toBeNull(); // limit reached
    const second = store.claim("w2", LEASE, 2);
    expect(second?.id).not.toBe(job.id);
    expect(store.claim("w3", LEASE, 5)).toBeNull(); // nothing left
  });

  it("only the lease owner can report on a job (duplicate execution)", () => {
    const { job } = store.enqueue(selftest());
    store.claim("w1", LEASE, 1);
    expect(store.heartbeat(job.id, "intruder", LEASE)).toBeNull();
    expect(store.succeed(job.id, "intruder", undefined)).toBe(false);
    expect(
      store.fail(job.id, "intruder", { code: "X", message: "x", retryable: false }),
    ).toBeNull();
    expect(store.get(job.id)?.status).toBe("running");
  });

  it("requeues an expired lease; the stale owner can no longer complete it", () => {
    const { job } = store.enqueue(selftest());
    store.claim("crashed-worker", LEASE, 1);
    clock += LEASE + 1;
    expect(store.recoverExpired()).toBe(1);
    expect(store.get(job.id)).toMatchObject({ status: "queued", error: { code: "LEASE_EXPIRED" } });
    clock += 1_000; // past retry backoff
    expect(store.claim("w2", LEASE, 1)).toMatchObject({ id: job.id, attempt: 2 });
    expect(store.succeed(job.id, "crashed-worker", undefined)).toBe(false);
    expect(store.succeed(job.id, "w2", undefined)).toBe(true);
  });

  it("recovers jobs interrupted by a crash on startup", () => {
    const { job } = store.enqueue(selftest());
    store.claim("previous-process", LEASE, 1);
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.get(job.id)).toMatchObject({
      status: "queued",
      error: { code: "INTERRUPTED", retryable: true },
    });
  });

  it("retries with backoff, then fails permanently when attempts are exhausted", () => {
    const { job } = store.enqueue(selftest({ maxAttempts: 2 }));
    store.claim("w", LEASE, 1);
    expect(store.fail(job.id, "w", { code: "FLAKY", message: "try again", retryable: true })).toBe(
      "queued",
    );
    expect(store.claim("w", LEASE, 1)).toBeNull(); // still backing off
    clock += 1_000;
    store.claim("w", LEASE, 1);
    expect(store.fail(job.id, "w", { code: "FLAKY", message: "try again", retryable: true })).toBe(
      "failed",
    );
    expect(store.get(job.id)).toMatchObject({
      status: "failed",
      attempt: 2,
      error: { code: "FLAKY" },
    });
  });

  it("fails immediately on permanent errors", () => {
    const { job } = store.enqueue(selftest());
    store.claim("w", LEASE, 1);
    expect(store.fail(job.id, "w", { code: "BAD_INPUT", message: "nope", retryable: false })).toBe(
      "failed",
    );
  });

  it("cancels queued jobs directly and running jobs via their runner", () => {
    const queued = store.enqueue(selftest({ priority: -1 })).job;
    const running = store.enqueue(selftest({ priority: 1 })).job;
    store.claim("w", LEASE, 1);
    expect(store.requestCancel(queued.id)?.status).toBe("cancelled");
    expect(store.requestCancel(running.id)).toMatchObject({
      status: "running",
      cancelRequested: true,
    });
    expect(store.heartbeat(running.id, "w", LEASE)).toEqual({ cancelRequested: true });
    expect(store.markCancelled(running.id, "w")).toBe(true);
    expect(() => store.requestCancel(running.id)).toThrow(/cannot move from cancelled/);
  });

  it("does not resurrect a cancel-requested job during recovery", () => {
    const { job } = store.enqueue(selftest());
    store.claim("w", LEASE, 1);
    store.requestCancel(job.id);
    store.recoverInterrupted();
    expect(store.get(job.id)?.status).toBe("cancelled");
  });

  it("returns released jobs to the queue without consuming an attempt", () => {
    const { job } = store.enqueue(selftest());
    store.claim("w", LEASE, 1);
    expect(store.release(job.id, "w")).toBe(true);
    expect(store.get(job.id)).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("claims each job exactly once across concurrent threads and connections", async () => {
    const big = new JobStore(db.handle.db, { maxQueued: 1_000 });
    const ids = Array.from({ length: 200 }, () => big.enqueue(selftest()).job.id);
    const run = (owner: string) =>
      new Promise<string[]>((resolve, reject) => {
        const worker = new Worker(new URL("./claim-worker.fixture.ts", import.meta.url), {
          execArgv: ["--import", "tsx"],
          workerData: { path: db.path, owner },
        });
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    const results = await Promise.all([run("t1"), run("t2"), run("t3")]);
    const all = results.flat();
    expect(all).toHaveLength(ids.length);
    expect(new Set(all).size).toBe(ids.length);
    expect(store.counts().succeeded).toBe(200);
  }, 30_000);
});

describe("retryDelayMs", () => {
  it("grows exponentially with bounded jitter and a cap", () => {
    expect(retryDelayMs(1, () => 0)).toBe(RETRY_BASE_DELAY_MS / 2);
    expect(retryDelayMs(1, () => 1)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(3, () => 0)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(50, () => 1)).toBe(RETRY_MAX_DELAY_MS);
  });
});
