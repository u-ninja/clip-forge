import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPendingRestore,
  backupDatabase,
  backupsDirFor,
  checkIntegrity,
  databaseInfo,
  listBackups,
  migrationStatus,
  stageRestore,
  verifyDatabaseFile,
} from "./backup.js";
import { openDatabase, runMigrations, type DatabaseHandle } from "./client.js";
import { channels } from "./schema.js";

describe("backup and restore", () => {
  let dir: string;
  let dbPath: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clipforge-backup-"));
    dbPath = join(dir, "data", "app.db");
    handle = openDatabase(dbPath);
    runMigrations(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const channelNames = (h: DatabaseHandle) =>
    h.db
      .select()
      .from(channels)
      .all()
      .map((c) => c.name);

  it("reports integrity, schema version and info", () => {
    expect(checkIntegrity(handle.sqlite).ok).toBe(true);
    const { applied, available } = migrationStatus(handle.sqlite);
    expect(applied).toBe(available);
    const info = databaseInfo(handle, dbPath);
    expect(info).toMatchObject({ journalMode: "wal", foreignKeys: true, pendingRestore: false });
    expect(info.schemaVersion).toBeGreaterThan(0);
  });

  it("creates a verified online backup and lists it", async () => {
    handle.db.insert(channels).values({ name: "Before" }).run();
    const backup = await backupDatabase(handle, dbPath, "manual");
    expect(backup.label).toBe("manual");
    expect(verifyDatabaseFile(join(backupsDirFor(dbPath), backup.id)).ok).toBe(true);
    expect(listBackups(dbPath).map((b) => b.id)).toEqual([backup.id]);
  });

  it("restores on next start and keeps the replaced database", async () => {
    handle.db.insert(channels).values({ name: "Before" }).run();
    const backup = await backupDatabase(handle, dbPath, "manual");
    handle.db.insert(channels).values({ name: "After" }).run();

    stageRestore(dbPath, backup.id, migrationStatus(handle.sqlite).available);
    // Staging alone never touches the live database.
    expect(channelNames(handle).sort()).toEqual(["After", "Before"]);
    expect(databaseInfo(handle, dbPath).pendingRestore).toBe(true);

    handle.close();
    const outcome = await applyPendingRestore(dbPath);
    expect(outcome.status).toBe("applied");
    handle = openDatabase(dbPath);
    expect(channelNames(handle)).toEqual(["Before"]);

    // The database that was replaced is preserved as a pre-restore backup.
    const preRestore = listBackups(dbPath).find((b) => b.label === "pre-restore");
    expect(preRestore).toBeDefined();
    const old = openDatabase(join(backupsDirFor(dbPath), preRestore!.id));
    expect(channelNames(old).sort()).toEqual(["After", "Before"]);
    old.close();
  });

  it("does nothing when no restore is staged", async () => {
    expect(await applyPendingRestore(dbPath)).toEqual({ status: "none" });
  });

  it("rejects path traversal and unknown backup ids", () => {
    for (const id of ["../app.db", "..%2fapp.db", "missing.db", "/etc/passwd"]) {
      expect(() => {
        stageRestore(dbPath, id, 99);
      }).toThrow(/Backup not found/);
    }
  });

  it("refuses corrupt backups and backups from newer versions", async () => {
    const backup = await backupDatabase(handle, dbPath, "manual");
    expect(() => {
      stageRestore(dbPath, backup.id, 0);
    }).toThrow(/newer version/);

    const corrupt = "manual-corrupt.db";
    writeFileSync(join(backupsDirFor(dbPath), corrupt), "not a database");
    expect(verifyDatabaseFile(join(backupsDirFor(dbPath), corrupt)).ok).toBe(false);
    expect(() => {
      stageRestore(dbPath, corrupt, 99);
    }).toThrow(/integrity/);
  });

  it("rejects a staged restore that became corrupt without touching the database", async () => {
    handle.db.insert(channels).values({ name: "Live" }).run();
    writeFileSync(`${dbPath}.restore-pending`, "garbage");
    handle.close();
    const outcome = await applyPendingRestore(dbPath);
    expect(outcome.status).toBe("rejected");
    expect(existsSync(`${dbPath}.restore-pending`)).toBe(false);
    handle = openDatabase(dbPath);
    expect(channelNames(handle)).toEqual(["Live"]);
  });
});
