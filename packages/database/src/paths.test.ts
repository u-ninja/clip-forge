import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ID, LEGACY_APP_IDS } from "@clipforge/shared";
import { appDataDir, defaultDatabasePath, migrateLegacyDataDir } from "./paths.js";

describe("migrateLegacyDataDir", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let legacyDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clipforge-paths-"));
    // Point every platform's data root into the temp dir.
    env = { HOME: root, APPDATA: join(root, "appdata"), XDG_DATA_HOME: join(root, "xdg") };
    legacyDir = appDataDir(env).replace(APP_ID, LEGACY_APP_IDS[0]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedLegacyDatabase(): void {
    mkdirSync(join(legacyDir, "data"), { recursive: true });
    const db = new Database(join(legacyDir, "data", "app.db"));
    db.exec("create table t (v text); insert into t values ('kept');");
    db.close();
  }

  it("copies legacy data so the database opens from the new location", () => {
    seedLegacyDatabase();
    const result = migrateLegacyDataDir(env);
    expect(result.status).toBe("migrated");

    const db = new Database(defaultDatabasePath(env), { readonly: true });
    expect(db.prepare("select v from t").get()).toEqual({ v: "kept" });
    db.close();
    expect(existsSync(join(legacyDir, "data", "app.db"))).toBe(true); // legacy preserved
  });

  it("is idempotent and never overwrites an existing target", () => {
    seedLegacyDatabase();
    mkdirSync(appDataDir(env), { recursive: true });
    writeFileSync(join(appDataDir(env), "marker"), "new");

    expect(migrateLegacyDataDir(env)).toEqual({ status: "skipped", reason: "target-exists" });
    expect(readFileSync(join(appDataDir(env), "marker"), "utf8")).toBe("new");
    expect(existsSync(defaultDatabasePath(env))).toBe(false);
  });

  it("recovers from an interrupted earlier copy", () => {
    seedLegacyDatabase();
    mkdirSync(`${appDataDir(env)}.migrating`, { recursive: true });
    writeFileSync(join(`${appDataDir(env)}.migrating`, "partial"), "x");

    expect(migrateLegacyDataDir(env).status).toBe("migrated");
    expect(existsSync(join(appDataDir(env), "partial"))).toBe(false);
    expect(existsSync(`${appDataDir(env)}.migrating`)).toBe(false);
  });

  it("does nothing without legacy data or with an explicit data dir", () => {
    expect(migrateLegacyDataDir(env)).toEqual({ status: "skipped", reason: "no-legacy-data" });
    seedLegacyDatabase();
    expect(migrateLegacyDataDir({ ...env, CLIPFORGE_DATA_DIR: join(root, "x") }).status).toBe(
      "skipped",
    );
  });
});
