import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  applyPendingRestore,
  backupDatabase,
  checkIntegrity,
  migrateLegacyDataDir,
  migrationStatus,
  openDatabase,
  runMigrations,
} from "@clipforge/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs/store.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const PARENT_CHECK_MS = 2_000;

/** Pre-logger fatal path: one JSON line in the same shape pino writes, then exit. */
function fatal(code: string, msg: string): never {
  process.stderr.write(
    `${JSON.stringify({ level: 60, time: Date.now(), service: "api", code, msg })}\n`,
  );
  process.exit(1);
}

const pkg = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

let config;
try {
  config = loadConfig();
} catch (err) {
  fatal("CONFIG_INVALID", err instanceof Error ? err.message : "Invalid configuration");
}
// The secret lives only in memory from here on; nothing this process spawns can inherit it.
delete process.env.CLIPFORGE_API_SECRET;

// Before opening the DB: legacy-identifier copy (ADR-009), then any restore the user staged.
const dataMigration = migrateLegacyDataDir();
const restore = await applyPendingRestore(config.databasePath);
const database = openDatabase(config.databasePath);

// Refuse to run on a damaged database rather than risk making it worse. Nothing is reset.
const integrity = checkIntegrity(database.sqlite, "quick");
if (!integrity.ok) {
  database.close();
  fatal(
    "DB_CORRUPT",
    `Database failed its integrity check; see docs/OPERATIONS.md (${integrity.problems[0] ?? ""})`,
  );
}

// Safe upgrades: snapshot an existing database before applying new migrations to it.
const { applied, available } = migrationStatus(database.sqlite);
const preMigrationBackup =
  applied > 0 && applied < available
    ? await backupDatabase(database, config.databasePath, "pre-migration")
    : null;
runMigrations(database.db);

const jobs = new JobStore(database.db, { maxQueued: config.maxQueuedJobs });
const app = await buildApp(config, pkg, { database, databasePath: config.databasePath, jobs });

app.log.info(
  {
    operation: "startup",
    dataMigration,
    restore,
    preMigrationBackup: preMigrationBackup?.id ?? null,
    applied,
    available,
  },
  "database ready",
);

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ operation: "shutdown", reason }, "shutting down");
  const timer = setTimeout(() => {
    app.log.error("shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.runner.stop();
    await app.close();
  } finally {
    database.close();
    app.log.info({ operation: "shutdown" }, "stopped");
  }
  // Orphaned by a crashed desktop: also end the rest of our process group (e.g. `tsx watch` and
  // `pnpm` in development, which would otherwise idle forever). The runtime created this group for
  // this service alone. POSIX only; on Windows the runtime kills the tree.
  if (reason === "parent-exited" && process.platform !== "win32") process.kill(0, "SIGTERM");
}
// `on`, not `once`: a repeated signal (the runtime signals the process group, and dev wrappers like
// tsx relay it again) must not fall through to the default handler and kill us mid-shutdown.
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Orphan protection: if the desktop process dies without stopping us, exit on our own.
const { parentPid } = config;
if (parentPid !== undefined) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void shutdown("parent-exited");
    }
  }, PARENT_CHECK_MS).unref();
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.runner.start();
} catch (err) {
  app.log.fatal({ err, operation: "startup" }, "failed to start");
  database.close();
  process.exit(1);
}
