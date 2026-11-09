import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  BACKUP_ID_PATTERN,
  type BackupInfo,
  type DatabaseInfo,
  type IntegrityResult,
} from "@clipforge/shared";
import { MIGRATIONS_DIR, type DatabaseHandle } from "./client.js";

export type BackupLabel = BackupInfo["label"];

const MAX_REPORTED_PROBLEMS = 20;
/** Automatic pre-migration backups kept; manual and pre-restore backups are never pruned. */
const KEEP_PRE_MIGRATION_BACKUPS = 5;

export class BackupError extends Error {
  constructor(
    readonly code: "BACKUP_NOT_FOUND" | "BACKUP_INVALID" | "BACKUP_TOO_NEW",
    message: string,
  ) {
    super(message);
  }
}

export const backupsDirFor = (dbPath: string): string => join(dirname(dbPath), "backups");
const pendingRestorePath = (dbPath: string): string => `${dbPath}.restore-pending`;

/** Replaces the home directory with `~` so paths can be shown or exported without the username. */
export function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Runs `PRAGMA quick_check` (fast) or `integrity_check` (thorough) on an open connection. */
export function checkIntegrity(
  sqlite: Database.Database,
  mode: "quick" | "full" = "full",
): IntegrityResult {
  const pragma = mode === "quick" ? "quick_check" : "integrity_check";
  const rows = sqlite.pragma(`${pragma}(${MAX_REPORTED_PROBLEMS})`, { simple: false }) as Record<
    string,
    string
  >[];
  const messages = rows.map((r) => Object.values(r)[0] ?? "");
  const ok = messages.length === 1 && messages[0] === "ok";
  return { ok, problems: ok ? [] : messages, checkedAt: Date.now() };
}

/** Applied migrations (rows in drizzle's journal table) vs. migrations shipped with this build. */
export function migrationStatus(sqlite: Database.Database): {
  applied: number;
  available: number;
} {
  const available = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).length;
  const table = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'")
    .get();
  if (!table) return { applied: 0, available };
  const row = sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as {
    n: number;
  };
  return { applied: row.n, available };
}

export function databaseInfo(handle: DatabaseHandle, dbPath: string): DatabaseInfo {
  const { sqlite } = handle;
  const { applied, available } = migrationStatus(sqlite);
  const pageCount = sqlite.pragma("page_count", { simple: true }) as number;
  const pageSize = sqlite.pragma("page_size", { simple: true }) as number;
  const version = sqlite.prepare("select sqlite_version() as v").get() as { v: string };
  return {
    path: displayPath(dbPath),
    sqliteVersion: version.v,
    schemaVersion: applied,
    availableMigrations: available,
    sizeBytes: pageCount * pageSize,
    journalMode: String(sqlite.pragma("journal_mode", { simple: true })),
    foreignKeys: sqlite.pragma("foreign_keys", { simple: true }) === 1,
    pendingRestore: existsSync(pendingRestorePath(dbPath)),
  };
}

/** Opens a database file read-only and checks it is intact and was produced by this app. */
export function verifyDatabaseFile(path: string): IntegrityResult & { schemaVersion: number } {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = checkIntegrity(sqlite, "full");
    const { applied } = migrationStatus(sqlite);
    if (integrity.ok && applied === 0) {
      return {
        ok: false,
        problems: ["not a ClipForge database"],
        checkedAt: Date.now(),
        schemaVersion: 0,
      };
    }
    return { ...integrity, schemaVersion: applied };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [message], checkedAt: Date.now(), schemaVersion: 0 };
  } finally {
    sqlite?.close();
  }
}

/**
 * Online backup via SQLite's backup API (consistent while the app keeps writing),
 * then verified by reopening the copy. A copy that fails verification is deleted and reported.
 */
export async function backupDatabase(
  handle: DatabaseHandle,
  dbPath: string,
  label: BackupLabel,
): Promise<BackupInfo> {
  const dir = backupsDirFor(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").toLowerCase();
  const id = `${label}-${stamp}-${randomBytes(2).toString("hex")}.db`;
  const target = join(dir, id);
  await handle.sqlite.backup(target);
  const check = verifyDatabaseFile(target);
  if (!check.ok) {
    rmSync(target, { force: true });
    throw new BackupError(
      "BACKUP_INVALID",
      `Backup failed verification: ${check.problems.join("; ")}`,
    );
  }
  if (label === "pre-migration") prunePreMigrationBackups(dir);
  return describeBackup(dir, id);
}

export function listBackups(dbPath: string): BackupInfo[] {
  const dir = backupsDirFor(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => BACKUP_ID_PATTERN.test(f) && labelOf(f) !== undefined)
    .map((f) => describeBackup(dir, f))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Stages a verified backup to replace the database on the next API start.
 * Nothing is overwritten now: the running database stays untouched until restart,
 * and the restart keeps a `pre-restore` copy of it.
 */
export function stageRestore(dbPath: string, backupId: string, available: number): void {
  const source = resolveBackup(dbPath, backupId);
  const check = verifyDatabaseFile(source);
  if (!check.ok) throw new BackupError("BACKUP_INVALID", "Backup failed its integrity check");
  if (check.schemaVersion > available) {
    throw new BackupError("BACKUP_TOO_NEW", "Backup was made by a newer version of the app");
  }
  const pending = pendingRestorePath(dbPath);
  const tmp = `${pending}.tmp`;
  copyFileSync(source, tmp);
  renameSync(tmp, pending);
}

export type RestoreOutcome =
  | { readonly status: "none" }
  | { readonly status: "applied"; readonly preRestoreBackup: string | null }
  | { readonly status: "rejected"; readonly keptAt: string };

/**
 * Applies a staged restore. Must run before the database is opened.
 * The current database is preserved as a `pre-restore` backup before it is replaced.
 */
export async function applyPendingRestore(dbPath: string): Promise<RestoreOutcome> {
  const pending = pendingRestorePath(dbPath);
  if (!existsSync(pending)) return { status: "none" };

  if (!verifyDatabaseFile(pending).ok) {
    const keptAt = `${dbPath}.restore-rejected-${Date.now()}`;
    renameSync(pending, keptAt);
    return { status: "rejected", keptAt };
  }

  let preRestoreBackup: string | null = null;
  if (existsSync(dbPath)) preRestoreBackup = await preserveCurrent(dbPath);

  // After a TRUNCATE checkpoint these are empty, but a stale WAL must never be replayed onto the restored file.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(pending, dbPath);
  return { status: "applied", preRestoreBackup };
}

async function preserveCurrent(dbPath: string): Promise<string> {
  const dir = backupsDirFor(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").toLowerCase();
  const id = `pre-restore-${stamp}-${randomBytes(2).toString("hex")}.db`;
  try {
    const sqlite = new Database(dbPath, { fileMustExist: true });
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      await sqlite.backup(join(dir, id));
    } finally {
      sqlite.close();
    }
  } catch {
    // The current file may be corrupt (the usual reason to restore): keep its raw bytes instead.
    copyFileSync(dbPath, join(dir, id));
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, join(dir, `${id}-wal`));
  }
  return id;
}

function resolveBackup(dbPath: string, backupId: string): string {
  // Ids are plain file names matched against a strict pattern, so they cannot traverse directories.
  if (!BACKUP_ID_PATTERN.test(backupId) || basename(backupId) !== backupId) {
    throw new BackupError("BACKUP_NOT_FOUND", "Backup not found");
  }
  const path = join(backupsDirFor(dbPath), backupId);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new BackupError("BACKUP_NOT_FOUND", "Backup not found");
  }
  return path;
}

function labelOf(file: string): BackupLabel | undefined {
  if (file.startsWith("pre-migration-")) return "pre-migration";
  if (file.startsWith("pre-restore-")) return "pre-restore";
  if (file.startsWith("manual-")) return "manual";
  return undefined;
}

function describeBackup(dir: string, id: string): BackupInfo {
  const stat = statSync(join(dir, id));
  return { id, label: labelOf(id) ?? "manual", sizeBytes: stat.size, createdAt: stat.mtimeMs };
}

function prunePreMigrationBackups(dir: string): void {
  readdirSync(dir)
    .filter((f) => f.startsWith("pre-migration-") && BACKUP_ID_PATTERN.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(KEEP_PRE_MIGRATION_BACKUPS)
    .forEach(({ f }) => {
      rmSync(join(dir, f), { force: true });
    });
}
