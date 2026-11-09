import { readFileSync } from "node:fs";
import { z } from "zod";
import { migrateLegacyDataDir, openDatabase, runMigrations } from "@clipforge/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const pkg = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

// Fail fast: refuse to start if config is invalid or the database can't be opened/migrated.
const config = loadConfig();
// Before opening the DB: carries data over from the pre-rename identifier (copy, once).
const dataMigration = migrateLegacyDataDir();
const database = openDatabase(config.databasePath);
runMigrations(database.db);

const app = await buildApp(config, pkg);
app.log.info({ dataMigration }, "legacy data check");
app.log.info({ databasePath: config.databasePath }, "database ready");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => {
    app.log.error("shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close();
  } finally {
    database.close();
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.fatal({ err }, "failed to start");
  database.close();
  process.exit(1);
}
