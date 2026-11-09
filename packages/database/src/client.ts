import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: AppDatabase;
  /** Raw connection, for pragmas and online backups (`sqlite.backup()`). */
  readonly sqlite: Database.Database;
  close(): void;
}

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens the SQLite database. The API process is the single owner/writer;
 * other processes must go through the API rather than opening this file.
 */
export function openDatabase(path: string): DatabaseHandle {
  // Owner-only: other accounts on a shared machine must not read the database.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return { db: drizzle(sqlite, { schema }), sqlite, close: () => sqlite.close() };
}

/** Applies pending migrations inside drizzle's migration transaction. Idempotent. */
export function runMigrations(db: AppDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
