import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { healthResponseSchema, versionResponseSchema } from "@clipforge/shared";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig({
  NODE_ENV: "test",
  CLIPFORGE_LOG_LEVEL: "fatal",
  CLIPFORGE_DATA_DIR: "/nonexistent",
});
const host = { host: `127.0.0.1:${config.port}` };

describe("api", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(config, { name: "test-api", version: "1.2.3" });
  });
  afterAll(() => app.close());

  it("GET /health matches the shared contract", async () => {
    const res = await app.inject({ url: "/health", headers: host });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json()).status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /api/version returns package info", async () => {
    const res = await app.inject({ url: "/api/version", headers: host });
    expect(versionResponseSchema.parse(res.json()).version).toBe("1.2.3");
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await app.inject({ url: "/health", headers: { host: "evil.example:4317" } });
    expect(res.statusCode).toBe(421);
  });

  it("only allows the desktop origin via CORS", async () => {
    const ok = await app.inject({
      url: "/health",
      headers: { ...host, origin: "tauri://localhost" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    const bad = await app.inject({
      url: "/health",
      headers: { ...host, origin: "https://evil.example" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await app.inject({ url: "/nope", headers: host });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("config", () => {
  it("refuses non-loopback hosts", () => {
    expect(() => loadConfig({ CLIPFORGE_API_HOST: "0.0.0.0" })).toThrow(
      /Invalid API configuration/,
    );
  });
});
