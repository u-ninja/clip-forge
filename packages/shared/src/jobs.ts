/** Job kinds the runner knows how to execute. Phase 2 ships only the infrastructure self-test. */
export const JOB_KINDS = ["system.selftest"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Persisted job lifecycle. Every production/render/publish job uses these states. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled"],
  // running -> queued is a retry or crash recovery on startup.
  running: ["succeeded", "failed", "paused", "cancelled", "queued"],
  paused: ["queued", "cancelled"],
  failed: ["queued"], // manual or scheduled retry
  succeeded: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
