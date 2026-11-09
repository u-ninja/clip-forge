import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Request signing between the Tauri runtime and the API (ADR-010).
 * signature = HMAC-SHA256(secret, "CFL1\n" + METHOD + "\n" + url + "\n" + ts + "\n" + nonce + "\n" + sha256(body))
 * The Rust implementation in apps/desktop/src-tauri/src/auth.rs must stay byte-for-byte compatible.
 */
export const AUTH_HEADERS = {
  timestamp: "x-clipforge-timestamp",
  nonce: "x-clipforge-nonce",
  signature: "x-clipforge-signature",
} as const;

/** Accepted clock difference between signer and API (same machine, so small). */
export const MAX_CLOCK_SKEW_MS = 30_000;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{13}$/;
const MAX_TRACKED_NONCES = 10_000;

export type AuthFailure =
  "missing" | "malformed" | "expired" | "bad-signature" | "replayed" | "overloaded";

const sha256Hex = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

export function computeSignature(
  secret: Buffer,
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  const canonical = ["CFL1", method.toUpperCase(), url, timestamp, nonce, sha256Hex(body)].join(
    "\n",
  );
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/** Builds signed headers. Used by tests and `pnpm api:call`; production signing happens in Rust. */
export function signRequest(
  secret: Buffer,
  method: string,
  url: string,
  body: Buffer | string = "",
  now = Date.now(),
): Record<string, string> {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString("hex");
  return {
    [AUTH_HEADERS.timestamp]: timestamp,
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.signature]: computeSignature(secret, method, url, timestamp, nonce, body),
  };
}

/** Remembers nonces for twice the skew window so a captured request can't be replayed. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  /** Records the nonce; false if it was already used or the cache is saturated. */
  remember(nonce: string, now: number): "ok" | "replayed" | "overloaded" {
    this.prune(now);
    if (this.seen.has(nonce)) return "replayed";
    if (this.seen.size >= MAX_TRACKED_NONCES) return "overloaded";
    this.seen.set(nonce, now + 2 * MAX_CLOCK_SKEW_MS);
    return "ok";
  }

  // Insertion order ≈ expiry order, so expired entries are always at the front: O(expired).
  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(nonce);
    }
  }
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

const header = (headers: Headers, name: string): string | undefined => {
  const v = headers[name];
  return typeof v === "string" ? v : undefined;
};

/** Cheap structural check, done before the body is read. */
export function precheck(headers: Headers, now: number): AuthFailure | null {
  const ts = header(headers, AUTH_HEADERS.timestamp);
  const nonce = header(headers, AUTH_HEADERS.nonce);
  const sig = header(headers, AUTH_HEADERS.signature);
  if (ts === undefined || nonce === undefined || sig === undefined) return "missing";
  if (!TIMESTAMP_PATTERN.test(ts) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(sig)) {
    return "malformed";
  }
  if (Math.abs(now - Number(ts)) > MAX_CLOCK_SKEW_MS) return "expired";
  return null;
}

/** Full verification once the raw body is available. Call `precheck` first. */
export function verify(
  secret: Buffer,
  guard: ReplayGuard,
  method: string,
  url: string,
  headers: Headers,
  body: Buffer | string,
  now: number,
): AuthFailure | null {
  const pre = precheck(headers, now);
  if (pre) return pre;
  // precheck guarantees all three headers are present and well-formed.
  const ts = header(headers, AUTH_HEADERS.timestamp) ?? "";
  const nonce = header(headers, AUTH_HEADERS.nonce) ?? "";
  const given = Buffer.from(header(headers, AUTH_HEADERS.signature) ?? "", "hex");
  const expected = Buffer.from(computeSignature(secret, method, url, ts, nonce, body), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "bad-signature";
  // Only record nonces of authentic requests, so forged traffic can't fill the cache.
  const replay = guard.remember(nonce, now);
  return replay === "ok" ? null : replay;
}
