import { describe, expect, it } from "vitest";
import { JOB_STATUSES, canTransition, isTerminal } from "./jobs.js";

describe("job state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
  });

  it("rejects skipping execution or reviving terminal jobs", () => {
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("lets failed jobs be retried and interrupted jobs be requeued", () => {
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("running", "queued")).toBe(true);
  });

  it("marks only succeeded and cancelled as terminal", () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(["succeeded", "cancelled"]);
  });
});
