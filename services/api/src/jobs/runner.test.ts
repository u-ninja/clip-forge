import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { selftestPayloadSchema, type JobView } from "@clipforge/shared";
import { testApp, type TestApp } from "../test-support.js";
import { defaultHandlers, type JobHandler } from "./handlers.js";

const FAST = { leaseMs: 300, pollMs: 20 };

async function until(
  t: TestApp,
  id: string,
  pred: (j: JobView) => boolean,
  timeoutMs = 5_000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = t.store.get(id);
    if (job && pred(job)) return job;
    if (Date.now() > deadline) throw new Error(`timed out; last state ${JSON.stringify(job)}`);
    await sleep(10);
  }
}

describe("JobRunner", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const enqueue = async (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await t!.call("POST", "/api/v1/jobs", {
      kind: "system.selftest",
      payload,
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ job: JobView }>().job;
  };

  it("runs a job to completion and reports progress", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 100, steps: 4 });
    const done = await until(t, job.id, (j) => j.status === "succeeded");
    expect(done).toMatchObject({ progress: 1, attempt: 1 });
  });

  it("retries retryable failures and then succeeds", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 10, steps: 1, failAttempts: 2 });
    const done = await until(t, job.id, (j) => j.status === "succeeded");
    expect(done.attempt).toBe(3);
  });

  it("stops at the retry limit with structured failure info", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 10, steps: 1, failAttempts: 5 }, { maxAttempts: 2 });
    const done = await until(t, job.id, (j) => j.status === "failed");
    expect(done).toMatchObject({
      attempt: 2,
      error: { code: "SELFTEST_INJECTED_FAILURE", retryable: true },
    });
  });

  it("cancels a running job", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 5_000, steps: 50 });
    await until(t, job.id, (j) => j.status === "running");
    const res = await t.call("POST", `/api/v1/jobs/${job.id}/cancel`);
    expect(res.statusCode).toBe(200);
    await until(t, job.id, (j) => j.status === "cancelled");
  });

  it("times out hung handlers and fails them after the retry limit", async () => {
    const hang: JobHandler = {
      payloadSchema: selftestPayloadSchema,
      timeoutMs: 50,
      run: (_p, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    t = await testApp({ deps: { runnerOptions: FAST, handlers: { "system.selftest": hang } } });
    t.app.runner.start();
    const job = await enqueue({}, { maxAttempts: 1 });
    const done = await until(t, job.id, (j) => j.status === "failed");
    expect(done.error?.code).toBe("TIMEOUT");
  });

  it("abandons a job whose lease was taken over (worker crash/duplicate execution)", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 2_000, steps: 20 });
    await until(t, job.id, (j) => j.status === "running");
    // Simulate a recovery pass that decided the runner had crashed: the lease is reassigned.
    t.db.handle.sqlite
      .prepare("update jobs set lease_owner = 'someone-else' where id = ?")
      .run(job.id);
    const deadline = Date.now() + 2_000;
    while (t.app.runner.activeCount > 0 && Date.now() < deadline) await sleep(10);
    const after = t.store.get(job.id);
    expect(after).toMatchObject({ status: "running" }); // the original runner did not clobber it
    expect(t.app.runner.activeCount).toBe(0);
  });

  it("recovers jobs left running by a previous process when it starts", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    const job = (
      await t.call("POST", "/api/v1/jobs", {
        kind: "system.selftest",
        payload: { durationMs: 10, steps: 1 },
      })
    ).json<{ job: JobView }>();
    t.store.claim("dead-process", 60_000, 1);
    t.app.runner.start();
    await until(t, job.job.id, (j) => j.status === "succeeded");
  });

  it("returns active work to the queue on shutdown", async () => {
    t = await testApp({ deps: { runnerOptions: FAST } });
    t.app.runner.start();
    const job = await enqueue({ durationMs: 5_000, steps: 50 });
    await until(t, job.id, (j) => j.status === "running");
    await t.app.runner.stop();
    expect(t.store.get(job.id)).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("never runs more jobs at once than the concurrency limit", async () => {
    let concurrent = 0;
    let peak = 0;
    const tracked: JobHandler = {
      ...defaultHandlers["system.selftest"],
      run: async (_p, ctx) => {
        peak = Math.max(peak, ++concurrent);
        await sleep(30, undefined, { signal: ctx.signal });
        concurrent--;
        return undefined;
      },
    };
    t = await testApp({
      env: { CLIPFORGE_JOB_CONCURRENCY: "2" },
      deps: { runnerOptions: FAST, handlers: { "system.selftest": tracked } },
    });
    t.app.runner.start();
    const jobs = await Promise.all(Array.from({ length: 6 }, () => enqueue({})));
    for (const j of jobs) await until(t, j.id, (x) => x.status === "succeeded");
    expect(peak).toBe(2);
  });
});

describe("job routes", () => {
  let t: TestApp;
  afterEach(() => t.close());

  it("validates input, is idempotent and reports 404/409 correctly", async () => {
    t = await testApp();
    expect((await t.call("POST", "/api/v1/jobs", { kind: "rm -rf", payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (
        await t.call("POST", "/api/v1/jobs", {
          kind: "system.selftest",
          payload: { durationMs: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const body = { kind: "system.selftest", payload: {}, idempotencyKey: "idem-key-0001" };
    const first = await t.call("POST", "/api/v1/jobs", body);
    const second = await t.call("POST", "/api/v1/jobs", body);
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(second.json()).toEqual(first.json());
    const id = first.json<{ job: JobView }>().job.id;
    expect((await t.call("GET", `/api/v1/jobs/${id}`)).statusCode).toBe(200);
    expect((await t.call("GET", "/api/v1/jobs/not-a-uuid")).statusCode).toBe(400);
    expect(
      (await t.call("GET", "/api/v1/jobs/00000000-0000-4000-8000-000000000000")).statusCode,
    ).toBe(404);
    expect((await t.call("POST", `/api/v1/jobs/${id}/cancel`)).statusCode).toBe(200);
    expect((await t.call("POST", `/api/v1/jobs/${id}/cancel`)).json()).toMatchObject({
      error: { code: "INVALID_TRANSITION" },
    });
    const list = (await t.call("GET", "/api/v1/jobs?status=cancelled&limit=5")).json<{
      jobs: JobView[];
    }>();
    expect(list.jobs.map((j) => j.id)).toEqual([id]);
  });
});
