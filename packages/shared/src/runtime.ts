import { z } from "zod";
import { apiDiagnosticsSchema } from "./contracts.js";

/**
 * Contracts for data produced by the Tauri Rust runtime (IPC responses).
 * The Rust side serializes these shapes; the UI validates them before use.
 */

export const serviceStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("stopped") }),
  z.object({ state: z.literal("starting"), attempt: z.number().int() }),
  z.object({
    state: z.literal("running"),
    pid: z.number().int(),
    startedAt: z.number(),
    restarts: z.number().int(),
  }),
  z.object({ state: z.literal("stopping") }),
  z.object({ state: z.literal("failed"), reason: z.string(), at: z.number() }),
]);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const runtimeStatusSchema = z.object({
  mode: z.enum(["development", "production"]),
  api: serviceStatusSchema,
  worker: serviceStatusSchema,
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const apiProxyResponseSchema = z.object({
  status: z.number().int(),
  body: z.unknown(),
});

const processUsageSchema = z.object({
  name: z.string(),
  pid: z.number().int(),
  memoryBytes: z.number(),
  cpuPercent: z.number(),
});

export const resourceSnapshotSchema = z.object({
  totalMemoryBytes: z.number(),
  availableMemoryBytes: z.number(),
  cpuCount: z.number().int(),
  cpuBrand: z.string(),
  globalCpuPercent: z.number(),
  diskAvailableBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  processes: z.array(processUsageSchema),
});
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;

export const logEntrySchema = z.object({
  time: z.number(),
  service: z.string(),
  level: z.string(),
  message: z.string(),
});

export const diagnosticsReportSchema = z.object({
  generatedAt: z.number(),
  app: z.object({
    name: z.string(),
    version: z.string(),
    mode: z.enum(["development", "production"]),
  }),
  os: z.object({ name: z.string(), version: z.string(), arch: z.string() }),
  runtime: runtimeStatusSchema,
  resources: resourceSnapshotSchema,
  /** `null` with `apiError` set when the API could not be reached. */
  api: apiDiagnosticsSchema.nullable(),
  apiError: z.string().nullable(),
  logs: z.object({
    directory: z.string(),
    totalBytes: z.number(),
    fileCount: z.number().int(),
    maxBytes: z.number(),
    retentionDays: z.number().int(),
  }),
  recentErrors: z.array(logEntrySchema),
});
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;

export const exportResultSchema = z.object({ path: z.string() });
