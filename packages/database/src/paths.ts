import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_ID, LEGACY_APP_IDS } from "@clipforge/shared";

/** OS data root for an app id; matches Tauri's `appDataDir()` for the same identifier. */
function dataDirFor(appId: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", appId);
    case "win32":
      return join(env.APPDATA ?? join(home, "AppData", "Roaming"), appId);
    default:
      return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), appId);
  }
}

/**
 * Per-user application data directory.
 * `CLIPFORGE_DATA_DIR` overrides it (tests, portable installs).
 */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLIPFORGE_DATA_DIR ?? dataDirFor(APP_ID, env);
}

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDataDir(env), "data", "app.db");
}

export type LegacyDataMigration =
  | { readonly status: "migrated"; readonly from: string; readonly to: string }
  | {
      readonly status: "skipped";
      readonly reason: "override" | "target-exists" | "no-legacy-data";
    };

/**
 * Copies data from a pre-rename identifier's directory into the current one, once.
 * - Copies, never moves: the legacy directory stays intact as a backup.
 * - Never writes into an existing target; the copy is staged, then renamed into place atomically.
 * - Idempotent: once the target exists, it's a no-op. Must run before the database is opened.
 */
export function migrateLegacyDataDir(env: NodeJS.ProcessEnv = process.env): LegacyDataMigration {
  if (env.CLIPFORGE_DATA_DIR) return { status: "skipped", reason: "override" };
  const target = appDataDir(env);
  if (existsSync(target)) return { status: "skipped", reason: "target-exists" };
  const legacy = LEGACY_APP_IDS.map((id) => dataDirFor(id, env)).find((dir) => existsSync(dir));
  if (!legacy) return { status: "skipped", reason: "no-legacy-data" };

  // A leftover staging dir is an interrupted copy of data that still exists at `legacy`; safe to discard.
  const staging = `${target}.migrating`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(legacy, staging, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  renameSync(staging, target); // fails rather than replacing if the target appeared meanwhile
  return { status: "migrated", from: legacy, to: target };
}
