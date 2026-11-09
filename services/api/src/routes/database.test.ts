import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseResponseSchema, integrityResultSchema } from "@clipforge/shared";
import { testApp, type TestApp } from "../test-support.js";

describe("database routes", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await testApp();
  });
  afterEach(() => t.close());

  it("reports database info and backups", async () => {
    const res = await t.call("GET", "/api/v1/database");
    const body = databaseResponseSchema.parse(res.json());
    expect(body.database.schemaVersion).toBe(body.database.availableMigrations);
    expect(body.backups).toEqual([]);
  });

  it("creates a verified backup and runs an integrity check", async () => {
    const created = await t.call("POST", "/api/v1/database/backups");
    expect(created.statusCode).toBe(201);
    const list = databaseResponseSchema.parse((await t.call("GET", "/api/v1/database")).json());
    expect(list.backups).toHaveLength(1);
    const integrity = integrityResultSchema.parse(
      (await t.call("POST", "/api/v1/database/integrity-check")).json(),
    );
    expect(integrity.ok).toBe(true);
  });

  it("stages a restore only with explicit confirmation and a valid id", async () => {
    const { backup } = (await t.call("POST", "/api/v1/database/backups")).json<{
      backup: { id: string };
    }>();
    expect(
      (await t.call("POST", "/api/v1/database/restore", { backupId: backup.id })).statusCode,
    ).toBe(400);
    expect(
      (await t.call("POST", "/api/v1/database/restore", { backupId: "../app.db", confirm: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.call("POST", "/api/v1/database/restore", { backupId: "missing.db", confirm: true }))
        .statusCode,
    ).toBe(404);
    const ok = await t.call("POST", "/api/v1/database/restore", {
      backupId: backup.id,
      confirm: true,
    });
    expect(ok.statusCode).toBe(202);
    const info = databaseResponseSchema.parse((await t.call("GET", "/api/v1/database")).json());
    expect(info.database.pendingRestore).toBe(true);
  });
});
