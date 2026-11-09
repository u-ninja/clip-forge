import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES } from "./jobs.js";

/** Liveness/readiness probe. Intentionally minimal: it is the only unauthenticated endpoint. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const versionResponseSchema = z.object({
  name: z.string(),
  version: z.string(),
  node: z.string(),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

/** Uniform error envelope for every API error response. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------- Jobs ----------

export const jobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  at: z.number(),
});
export type JobErrorInfo = z.infer<typeof jobErrorSchema>;

export const jobSchema = z.object({
  id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  priority: z.number().int(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  progress: z.number().min(0).max(1),
  cancelRequested: z.boolean(),
  idempotencyKey: z.string().nullable(),
  error: jobErrorSchema.nullable(),
  runAfter: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type JobView = z.infer<typeof jobSchema>;

/** Payload of the built-in `system.selftest` job: exercises the runner without doing real work. */
export const selftestPayloadSchema = z.strictObject({
  durationMs: z.number().int().min(0).max(120_000).default(3_000),
  steps: z.number().int().min(1).max(100).default(10),
  /** Fail this many attempts with a retryable error before succeeding (tests retries). */
  failAttempts: z.number().int().min(0).max(5).default(0),
});

export const createJobRequestSchema = z.strictObject({
  kind: z.enum(JOB_KINDS),
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/)
    .optional(),
  priority: z.number().int().min(-10).max(10).default(0),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export type CreateJobRequest = z.input<typeof createJobRequestSchema>;

export const jobListQuerySchema = z.strictObject({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const jobResponseSchema = z.object({ job: jobSchema });
export const jobListResponseSchema = z.object({ jobs: z.array(jobSchema) });

// ---------- Database ----------

export const BACKUP_ID_PATTERN = /^[a-z0-9-]{1,100}\.db$/;

export const backupSchema = z.object({
  id: z.string().regex(BACKUP_ID_PATTERN),
  label: z.enum(["manual", "pre-migration", "pre-restore"]),
  sizeBytes: z.number().int(),
  createdAt: z.number(),
});
export type BackupInfo = z.infer<typeof backupSchema>;

export const databaseInfoSchema = z.object({
  /** Path with the user's home directory replaced by `~`. */
  path: z.string(),
  sqliteVersion: z.string(),
  schemaVersion: z.number().int(),
  availableMigrations: z.number().int(),
  sizeBytes: z.number().int(),
  journalMode: z.string(),
  foreignKeys: z.boolean(),
  pendingRestore: z.boolean(),
});
export type DatabaseInfo = z.infer<typeof databaseInfoSchema>;

export const integrityResultSchema = z.object({
  ok: z.boolean(),
  /** First problems reported by SQLite, capped; empty when ok. */
  problems: z.array(z.string()),
  checkedAt: z.number(),
});
export type IntegrityResult = z.infer<typeof integrityResultSchema>;

export const databaseResponseSchema = z.object({
  database: databaseInfoSchema,
  backups: z.array(backupSchema),
});

export const restoreRequestSchema = z.strictObject({
  backupId: z.string().regex(BACKUP_ID_PATTERN),
  /** Guard against accidental restores: the client must state intent explicitly. */
  confirm: z.literal(true),
});

// ---------- Diagnostics (API side) ----------

export const apiDiagnosticsSchema = z.object({
  api: z.object({
    version: z.string(),
    node: z.string(),
    pid: z.number().int(),
    uptimeSeconds: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
  }),
  database: databaseInfoSchema,
  jobs: z.object({
    counts: z.record(z.enum(JOB_STATUSES), z.number().int()),
    concurrency: z.number().int(),
    active: z.number().int(),
  }),
});
export type ApiDiagnostics = z.infer<typeof apiDiagnosticsSchema>;
