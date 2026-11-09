import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  apiErrorSchema,
  apiProxyResponseSchema,
  diagnosticsReportSchema,
  exportResultSchema,
  runtimeStatusSchema,
  type DiagnosticsReport,
  type RuntimeStatus,
} from "@clipforge/shared";

/**
 * The only way the UI reaches the backend: Tauri IPC into the Rust runtime.
 * The UI never holds the API session secret; Rust signs requests on its behalf (ADR-010).
 * Every response is validated, because IPC is a trust boundary too.
 */

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const commandErrorShape = (e: unknown): e is { code: string; message: string } =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  "message" in e &&
  typeof e.message === "string";

async function call<T extends z.ZodType>(
  command: string,
  schema: T,
  args?: Record<string, unknown>,
): Promise<z.output<T>> {
  if (!isTauri()) {
    throw new AppError(
      "DESKTOP_RUNTIME_UNAVAILABLE",
      "This screen needs the ClipForge desktop app.",
    );
  }
  let raw: unknown;
  try {
    raw = await invoke(command, args);
  } catch (err) {
    if (commandErrorShape(err)) throw new AppError(err.code, err.message);
    throw new AppError("IPC_FAILED", err instanceof Error ? err.message : String(err));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new AppError("INVALID_RESPONSE", `Unexpected response from ${command}`);
  return parsed.data;
}

export const runtime = {
  status: (): Promise<RuntimeStatus> => call("runtime_status", runtimeStatusSchema),
  // Commands returning Rust `()` serialize to null.
  restartApi: (): Promise<null> => call("api_restart", z.null()),
  startWorker: (): Promise<null> => call("worker_start", z.null()),
  stopWorker: (): Promise<null> => call("worker_stop", z.null()),
  diagnostics: (): Promise<DiagnosticsReport> =>
    call("diagnostics_report", diagnosticsReportSchema),
  exportDiagnostics: async (): Promise<string> =>
    (await call("diagnostics_export", exportResultSchema)).path,
};

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** Calls the local API through the Rust proxy and validates the response body. */
export async function api<T extends z.ZodType>(
  method: Method,
  path: `/api/v1/${string}`,
  schema: T,
  body?: unknown,
): Promise<z.output<T>> {
  const res = await call("api_request", apiProxyResponseSchema, {
    method,
    path,
    body: body ?? null,
  });
  if (res.status >= 400) {
    const err = apiErrorSchema.safeParse(res.body);
    throw err.success
      ? new AppError(err.data.error.code, err.data.error.message, res.status)
      : new AppError("HTTP_ERROR", `Request failed (HTTP ${res.status})`, res.status);
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new AppError("INVALID_RESPONSE", "Unexpected response from the API");
  return parsed.data;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}
