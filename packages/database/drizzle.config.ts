import { defineConfig } from "drizzle-kit";

// Only used for `drizzle-kit generate`. Migrations are applied by the API at startup or `pnpm db:migrate`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
