import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, runMigrations, type DatabaseHandle } from "@clipforge/database";
import { buildApp, type AppDeps } from "./app.js";
import { signRequest } from "./auth.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { JobStore } from "./jobs/store.js";

export const TEST_SECRET_HEX = "a".repeat(64);

export function testConfig(overrides: NodeJS.ProcessEnv = {}): ApiConfig {
  return loadConfig({
    NODE_ENV: "test",
    CLIPFORGE_LOG_LEVEL: "fatal",
    CLIPFORGE_DATA_DIR: "/nonexistent",
    CLIPFORGE_API_SECRET: TEST_SECRET_HEX,
    ...overrides,
  });
}

export interface TestDb {
  readonly dir: string;
  readonly path: string;
  readonly handle: DatabaseHandle;
  cleanup(): void;
}

export function tempDatabase(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "clipforge-api-"));
  const path = join(dir, "data", "app.db");
  const handle = openDatabase(path);
  runMigrations(handle.db);
  return {
    dir,
    path,
    handle,
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly db: TestDb;
  readonly store: JobStore;
  readonly config: ApiConfig;
  /** Sends a correctly signed request. */
  call(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function testApp(
  options: { env?: NodeJS.ProcessEnv; deps?: Partial<AppDeps> } = {},
): Promise<TestApp> {
  const config = testConfig(options.env);
  const db = tempDatabase();
  const store = new JobStore(db.handle.db, {
    maxQueued: config.maxQueuedJobs,
    retryDelay: () => 0,
  });
  const app = await buildApp(
    config,
    { name: "test-api", version: "1.2.3" },
    { database: db.handle, databasePath: db.path, jobs: store, ...options.deps },
  );
  const host = `127.0.0.1:${config.port}`;
  return {
    app,
    db,
    store,
    config,
    call: (method, url, body) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      return app.inject({
        method: method as "GET",
        url,
        payload: payload || undefined,
        headers: {
          host,
          ...(payload && { "content-type": "application/json" }),
          ...signRequest(config.secret, method, url, payload),
        },
      });
    },
    close: async () => {
      await app.runner.stop();
      await app.close();
      db.cleanup();
    },
  };
}
