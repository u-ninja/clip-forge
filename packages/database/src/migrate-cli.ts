import { openDatabase, runMigrations } from "./client.js";
import { defaultDatabasePath, migrateLegacyDataDir } from "./paths.js";

console.log("Legacy data:", JSON.stringify(migrateLegacyDataDir()));
const path = process.env.CLIPFORGE_DATABASE_PATH ?? defaultDatabasePath();
const handle = openDatabase(path);
try {
  runMigrations(handle.db);
  console.log(`Migrations applied: ${path}`);
} finally {
  handle.close();
}
