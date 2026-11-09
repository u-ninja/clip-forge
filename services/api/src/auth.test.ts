import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_HEADERS,
  MAX_CLOCK_SKEW_MS,
  ReplayGuard,
  computeSignature,
  signRequest,
} from "./auth.js";
import { testApp, type TestApp } from "./test-support.js";

const OTHER_SECRET = Buffer.from("b".repeat(64), "hex");

describe("session authentication", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(() => t.close());

  const inject = (method: string, url: string, headers: Record<string, string>, payload?: string) =>
    t.app.inject({
      method: method as "GET",
      url,
      payload,
      headers: {
        host: `127.0.0.1:${t.config.port}`,
        ...(payload !== undefined && { "content-type": "application/json" }),
        ...headers,
      },
    });

  const expectUnauthorized = (res: Awaited<ReturnType<typeof inject>>) => {
    expect(res.statusCode).toBe(401);
    // Generic body: no hint which check failed.
    expect(res.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  };

  it("accepts a valid signature", async () => {
    const res = await inject(
      "GET",
      "/api/v1/version",
      signRequest(t.config.secret, "GET", "/api/v1/version"),
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects missing credentials", async () => {
    expectUnauthorized(await inject("GET", "/api/v1/version", {}));
  });

  it("rejects partial or malformed credentials", async () => {
    const full = signRequest(t.config.secret, "GET", "/api/v1/version");
    const noSig = Object.fromEntries(
      Object.entries(full).filter(([k]) => k !== AUTH_HEADERS.signature),
    );
    expectUnauthorized(await inject("GET", "/api/v1/version", noSig));
    expectUnauthorized(
      await inject("GET", "/api/v1/version", {
        ...full,
        [AUTH_HEADERS.signature]: "zz".repeat(32),
      }),
    );
    expectUnauthorized(
      await inject("GET", "/api/v1/version", { ...full, [AUTH_HEADERS.nonce]: "short" }),
    );
  });

  it("rejects an invalid signature (wrong secret)", async () => {
    expectUnauthorized(
      await inject("GET", "/api/v1/version", signRequest(OTHER_SECRET, "GET", "/api/v1/version")),
    );
  });

  it("rejects expired and future-dated credentials", async () => {
    const old = Date.now() - MAX_CLOCK_SKEW_MS - 1_000;
    const future = Date.now() + MAX_CLOCK_SKEW_MS + 1_000;
    expectUnauthorized(
      await inject(
        "GET",
        "/api/v1/version",
        signRequest(t.config.secret, "GET", "/api/v1/version", "", old),
      ),
    );
    expectUnauthorized(
      await inject(
        "GET",
        "/api/v1/version",
        signRequest(t.config.secret, "GET", "/api/v1/version", "", future),
      ),
    );
  });

  it("rejects a replayed request", async () => {
    const headers = signRequest(t.config.secret, "GET", "/api/v1/version");
    expect((await inject("GET", "/api/v1/version", headers)).statusCode).toBe(200);
    expectUnauthorized(await inject("GET", "/api/v1/version", headers));
  });

  it("binds the signature to method, path, query and body", async () => {
    const body = JSON.stringify({ kind: "system.selftest", payload: {} });
    const signed = signRequest(t.config.secret, "POST", "/api/v1/jobs", body);
    // Same headers, tampered request each time.
    expectUnauthorized(
      await inject(
        "POST",
        "/api/v1/jobs",
        signed,
        JSON.stringify({ kind: "system.selftest", payload: { durationMs: 1 } }),
      ),
    );
    const getSigned = signRequest(t.config.secret, "GET", "/api/v1/jobs");
    expectUnauthorized(await inject("GET", "/api/v1/jobs?status=failed", getSigned));
    expectUnauthorized(
      await inject("DELETE", "/api/v1/jobs", signRequest(t.config.secret, "GET", "/api/v1/jobs")),
    );
  });

  it("does not let path tricks reach protected routes through the public health route", async () => {
    for (const url of [
      "/health/../api/v1/version",
      "/health/",
      "/HEALTH",
      "/api/v1/version?/health",
    ]) {
      const res = await inject("GET", url, {});
      expect(res.statusCode, url).toBe(401);
    }
    expectUnauthorized(await inject("POST", "/health", {}, "{}"));
    expectUnauthorized(await inject("GET", "/api/v1/unknown", {}));
  });

  it("rejects cross-origin and browser-originated requests, even when signed", async () => {
    for (const extra of <Record<string, string>[]>[
      { origin: "https://evil.example" },
      { origin: "tauri://localhost" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-mode": "cors" },
    ]) {
      const res = await inject("GET", "/api/v1/version", {
        ...signRequest(t.config.secret, "GET", "/api/v1/version"),
        ...extra,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect((await inject("GET", "/health", { origin: "https://evil.example" })).statusCode).toBe(
      403,
    );
  });

  it("rotates: a new session secret invalidates credentials from the old one", async () => {
    const next = await testApp({ env: { CLIPFORGE_API_SECRET: "b".repeat(64) } });
    try {
      const host = { host: `127.0.0.1:${next.config.port}` };
      const oldCreds = signRequest(t.config.secret, "GET", "/api/v1/version");
      expect(
        (await next.app.inject({ url: "/api/v1/version", headers: { ...host, ...oldCreds } }))
          .statusCode,
      ).toBe(401);
      const newCreds = signRequest(OTHER_SECRET, "GET", "/api/v1/version");
      expect(
        (await next.app.inject({ url: "/api/v1/version", headers: { ...host, ...newCreds } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await next.close();
    }
  });
});

describe("signature primitives", () => {
  it("matches the cross-language test vector shared with the Rust signer", () => {
    // Same vector is asserted in apps/desktop/src-tauri/src/auth.rs.
    const secret = Buffer.from("00".repeat(32), "hex");
    expect(
      computeSignature(
        secret,
        "post",
        "/api/v1/jobs?x=1",
        "1700000000000",
        "0".repeat(32),
        '{"a":1}',
      ),
    ).toBe(
      computeSignature(
        secret,
        "POST",
        "/api/v1/jobs?x=1",
        "1700000000000",
        "0".repeat(32),
        '{"a":1}',
      ),
    );
    expect(
      computeSignature(secret, "GET", "/api/v1/version", "1700000000000", "0".repeat(32), ""),
    ).toMatchInlineSnapshot(`"e5f2ecbc404caa5c33f3cac65db6159a98bddb22e6e8a66e522370717a518682"`);
  });

  it("replay guard forgets nonces after the window and bounds its size", () => {
    const guard = new ReplayGuard();
    expect(guard.remember("n1", 0)).toBe("ok");
    expect(guard.remember("n1", 1)).toBe("replayed");
    expect(guard.remember("n1", 2 * MAX_CLOCK_SKEW_MS + 1)).toBe("ok");
    for (let i = 0; i < 10_000; i++) guard.remember(`x${i}`, 10 * MAX_CLOCK_SKEW_MS);
    expect(guard.remember("overflow", 10 * MAX_CLOCK_SKEW_MS)).toBe("overloaded");
  });
});
