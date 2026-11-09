import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type DatabaseHandle } from "./client.js";
import { channels, productionJobs } from "./schema.js";

describe("database", () => {
  let dir: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clipforge-db-"));
    handle = openDatabase(join(dir, "test.db"));
    runMigrations(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies migrations idempotently and uses WAL + foreign keys", () => {
    expect(() => {
      runMigrations(handle.db);
    }).not.toThrow();
    const client = handle.sqlite;
    expect(client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("defaults ids, timestamps and job status", () => {
    const [channel] = handle.db.insert(channels).values({ name: "Test" }).returning().all();
    expect(channel?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(channel?.createdAt).toBeInstanceOf(Date);

    const [job] = handle.db
      .insert(productionJobs)
      .values({ channelId: channel!.id })
      .returning()
      .all();
    expect(job?.status).toBe("queued");
    expect(job?.attempt).toBe(0);
  });

  it("enforces foreign keys", () => {
    expect(() => handle.db.insert(productionJobs).values({ channelId: "missing" }).run()).toThrow(
      /FOREIGN KEY/,
    );
  });
});
