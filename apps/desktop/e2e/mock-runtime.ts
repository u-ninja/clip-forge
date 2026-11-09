import type { Page } from "@playwright/test";

/** Mutable state of the fake runtime, readable/writable from tests via `page.evaluate`. */
export interface MockState {
  api: Record<string, unknown>;
  worker: Record<string, unknown>;
  jobs: Record<string, unknown>[];
  /** Next api_request returns this HTTP error (then clears). */
  failNext: { status: number; code: string; message: string } | null;
}

declare global {
  interface Window {
    __mock: MockState;
    isTauri?: boolean;
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/**
 * Installs a fake `window.__TAURI_INTERNALS__` before the app loads. It implements the same
 * command contract as apps/desktop/src-tauri/src/commands.rs, with in-memory state.
 */
export async function installMockRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = Date.now();
    const running = { state: "running", pid: 4242, startedAt: now, restarts: 0 };
    const state: MockState = {
      api: running,
      worker: { state: "stopped" },
      jobs: [],
      failNext: null,
    };
    window.__mock = state;
    window.isTauri = true;

    const db = {
      path: "~/Library/Application Support/com.clipforge.local/data/app.db",
      sqliteVersion: "3.50.0",
      schemaVersion: 2,
      availableMigrations: 2,
      sizeBytes: 98_304,
      journalMode: "wal",
      foreignKeys: true,
      pendingRestore: false,
    };
    const counts = () => {
      const c: Record<string, number> = {
        queued: 0,
        running: 0,
        paused: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const j of state.jobs) c[String(j.status)] = (c[String(j.status)] ?? 0) + 1;
      return c;
    };
    // Each poll advances running jobs, so a long job visibly progresses and then completes.
    const advance = () => {
      for (const j of state.jobs) {
        if (j.status !== "running") continue;
        const progress = Math.min(1, Number(j.progress) + 0.25);
        j.progress = progress;
        if (progress >= 1) Object.assign(j, { status: "succeeded", finishedAt: Date.now() });
      }
    };
    const http = (status: number, body: unknown) => ({ status, body });
    const route = (method: string, path: string, body: unknown) => {
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        return http(f.status, { error: { code: f.code, message: f.message, requestId: "req-1" } });
      }
      if (method === "GET" && path.startsWith("/api/v1/jobs")) {
        advance();
        return http(200, { jobs: [...state.jobs].reverse() });
      }
      if (method === "POST" && path === "/api/v1/jobs") {
        const t = Date.now();
        const job = {
          id: crypto.randomUUID(),
          kind: (body as { kind: string }).kind,
          status: "running",
          priority: 0,
          attempt: 1,
          maxAttempts: 3,
          progress: 0,
          cancelRequested: false,
          idempotencyKey: null,
          error: null,
          runAfter: t,
          createdAt: t,
          updatedAt: t,
          startedAt: t,
          finishedAt: null,
        };
        state.jobs.push(job);
        return http(201, { job });
      }
      const cancel = /^\/api\/v1\/jobs\/([^/]+)\/cancel$/.exec(path);
      if (method === "POST" && cancel) {
        const job = state.jobs.find((j) => j.id === cancel[1]);
        if (!job) return http(404, { error: { code: "JOB_NOT_FOUND", message: "Job not found" } });
        Object.assign(job, { status: "cancelled", cancelRequested: true, finishedAt: Date.now() });
        return http(200, { job });
      }
      if (method === "GET" && path === "/api/v1/database")
        return http(200, { database: db, backups: [] });
      return http(404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    };
    const report = () => ({
      generatedAt: Date.now(),
      app: { name: "ClipForge Local", version: "0.1.0", mode: "development" },
      os: { name: "Darwin", version: "26.0", arch: "arm64" },
      runtime: { mode: "development", api: state.api, worker: state.worker },
      resources: {
        totalMemoryBytes: 16 * 1024 ** 3,
        availableMemoryBytes: 6 * 1024 ** 3,
        cpuCount: 8,
        cpuBrand: "Apple M2",
        globalCpuPercent: 12,
        diskAvailableBytes: 200 * 1024 ** 3,
        diskTotalBytes: 500 * 1024 ** 3,
        processes: [{ name: "desktop", pid: 100, memoryBytes: 120 * 1024 ** 2, cpuPercent: 1 }],
      },
      api:
        state.api.state === "running"
          ? {
              api: {
                version: "0.1.0",
                node: "v26.8.2",
                pid: 4242,
                uptimeSeconds: 60,
                rssBytes: 9e7,
                heapUsedBytes: 3e7,
              },
              database: db,
              jobs: { counts: counts(), concurrency: 1, active: 0 },
            }
          : null,
      apiError: state.api.state === "running" ? null : "API is not running",
      logs: {
        directory: "~/Library/Application Support/com.clipforge.local/logs",
        totalBytes: 2048,
        fileCount: 2,
        maxBytes: 100 * 1024 ** 2,
        retentionDays: 14,
      },
      recentErrors: [
        { time: Date.now(), service: "api", level: "warn", message: "request rejected" },
      ],
    });

    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args = {}) => {
        // Tauri rejects with the serialized CommandError `{ code, message }`; an Error carrying both matches it.
        const commandError = (code: string, message: string) =>
          Object.assign(new Error(message), { code });
        const unavailable = commandError("API_UNAVAILABLE", "The local API is not running");
        switch (cmd) {
          case "runtime_status":
            return Promise.resolve({ mode: "development", api: state.api, worker: state.worker });
          case "worker_start":
            state.worker = { state: "running", pid: 5151, startedAt: Date.now(), restarts: 0 };
            return Promise.resolve(null);
          case "worker_stop":
            state.worker = { state: "stopped" };
            return Promise.resolve(null);
          case "api_restart":
            state.api = { ...running, startedAt: Date.now() };
            return Promise.resolve(null);
          case "api_request":
            if (state.api.state !== "running") return Promise.reject(unavailable);
            return Promise.resolve(route(String(args.method), String(args.path), args.body));
          case "diagnostics_report":
            return Promise.resolve(report());
          case "diagnostics_export":
            return Promise.resolve({
              path: "~/Library/Application Support/com.clipforge.local/diagnostics/report.json",
            });
          default:
            return Promise.reject(commandError("UNKNOWN_COMMAND", cmd));
        }
      },
    };
  });
}

export async function setMock(page: Page, patch: Partial<MockState>): Promise<void> {
  await page.evaluate((p) => {
    Object.assign(window.__mock, p);
  }, patch);
}
