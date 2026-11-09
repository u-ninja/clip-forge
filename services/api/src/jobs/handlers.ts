import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import { selftestPayloadSchema, type JobKind } from "@clipforge/shared";

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  /** Aborted on cancellation, timeout, lost lease or shutdown. Handlers must honor it. */
  readonly signal: AbortSignal;
  /** Records progress in [0, 1]; also renews the lease. */
  reportProgress(progress: number): void;
  readonly log: FastifyBaseLogger;
}

export interface JobHandler {
  readonly payloadSchema: z.ZodType<Record<string, unknown>>;
  /** Hard limit per attempt; the runner aborts the signal and records a retryable TIMEOUT. */
  readonly timeoutMs: number;
  run(
    payload: Record<string, unknown>,
    ctx: JobContext,
  ): Promise<Record<string, unknown> | undefined>;
}

/** A failure the handler classified itself. Anything else thrown is treated as retryable. */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Infrastructure self-test: sleeps in steps, reports progress, optionally fails first attempts. */
const selftest: JobHandler = {
  payloadSchema: selftestPayloadSchema,
  timeoutMs: 150_000,
  async run(raw, ctx) {
    const payload = selftestPayloadSchema.parse(raw);
    if (ctx.attempt <= payload.failAttempts) {
      throw new JobFailure(
        "SELFTEST_INJECTED_FAILURE",
        `Injected failure on attempt ${ctx.attempt}`,
        true,
      );
    }
    const stepMs = payload.durationMs / payload.steps;
    for (let step = 1; step <= payload.steps; step++) {
      await sleep(stepMs, undefined, { signal: ctx.signal });
      ctx.reportProgress(step / payload.steps);
    }
    return { steps: payload.steps };
  },
};

export const defaultHandlers: Readonly<Record<JobKind, JobHandler>> = {
  "system.selftest": selftest,
};
