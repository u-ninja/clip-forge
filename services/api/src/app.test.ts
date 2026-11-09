import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiDiagnosticsSchema,
  healthResponseSchema,
  versionResponseSchema,
} from "@clipforge/shared";
import { loadConfig } from "./config.js";
import { TEST_SECRET_HEX, testApp, type TestApp } from "./test-support.js";

describe("api", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(() => t.close());
  const host = () => ({ host: `127.0.0.1:${t.config.port}` });

  it("GET /health is public, minimal and matches the shared contract", async () => {
    const res = await t.app.inject({ url: "/health", headers: host() });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.strict().parse(res.json())).toEqual({
      status: "ok",
      service: "api",
    });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /api/v1/version returns package info when signed", async () => {
    const res = await t.call("GET", "/api/v1/version");
    expect(versionResponseSchema.parse(res.json()).version).toBe("1.2.3");
  });

  it("GET /api/v1/diagnostics reports database and job state", async () => {
    const res = await t.call("GET", "/api/v1/diagnostics");
    const body = apiDiagnosticsSchema.parse(res.json());
    expect(body.database.journalMode).toBe("wal");
    expect(body.jobs.counts.queued).toBe(0);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await t.app.inject({ url: "/health", headers: { host: "evil.example:4317" } });
    expect(res.statusCode).toBe(421);
  });

  it("returns the error envelope for unknown routes once authenticated", async () => {
    const res = await t.call("GET", "/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("propagates safe correlation ids and replaces unsafe ones", async () => {
    const ok = await t.app.inject({
      url: "/health",
      headers: { ...host(), "x-request-id": "abc-12345678" },
    });
    expect(ok.headers["x-request-id"]).toBe("abc-12345678");
    const bad = await t.app.inject({
      url: "/health",
      headers: { ...host(), "x-request-id": "x\n{evil}" },
    });
    expect(bad.headers["x-request-id"]).not.toContain("\n");
  });

  it("rejects bodies above the size limit", async () => {
    const res = await t.call("POST", "/api/v1/jobs", {
      kind: "system.selftest",
      payload: { pad: "x".repeat(300_000) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("config", () => {
  const base = { CLIPFORGE_API_SECRET: TEST_SECRET_HEX };
  it("refuses non-loopback hosts", () => {
    expect(() => loadConfig({ ...base, CLIPFORGE_API_HOST: "0.0.0.0" })).toThrow(
      /Invalid API configuration/,
    );
  });

  it("requires a well-formed session secret and never echoes it", () => {
    expect(() => loadConfig({})).toThrow(/CLIPFORGE_API_SECRET/);
    const weak = "not-a-real-secret-value";
    expect(() => loadConfig({ CLIPFORGE_API_SECRET: weak })).toThrow(/64 lowercase hex/);
    try {
      loadConfig({ CLIPFORGE_API_SECRET: weak });
    } catch (err) {
      expect(String(err)).not.toContain(weak);
    }
  });
});
