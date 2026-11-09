import { z } from "zod";
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "@clipforge/shared";
import { defaultDatabasePath } from "@clipforge/database";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Loopback only: the API has no auth yet, so it must never listen on a public interface.
  CLIPFORGE_API_HOST: z.enum(LOOPBACK_HOSTS).default(DEFAULT_API_HOST),
  CLIPFORGE_API_PORT: z.coerce.number().int().min(1024).max(65535).default(DEFAULT_API_PORT),
  CLIPFORGE_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CLIPFORGE_DATABASE_PATH: z.string().min(1).optional(),
});

export interface ApiConfig {
  readonly env: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databasePath: string;
}

/** Validates environment once at startup; throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid API configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    env: e.NODE_ENV,
    host: e.CLIPFORGE_API_HOST,
    port: e.CLIPFORGE_API_PORT,
    logLevel: e.CLIPFORGE_LOG_LEVEL,
    databasePath: e.CLIPFORGE_DATABASE_PATH ?? defaultDatabasePath(env),
  };
}
