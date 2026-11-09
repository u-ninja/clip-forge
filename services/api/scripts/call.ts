// Dev helper: send a signed request to a standalone API.
//   CLIPFORGE_API_SECRET=<same hex as the API> pnpm --filter @clipforge/api call GET /api/v1/diagnostics
//   ... call POST /api/v1/jobs '{"kind":"system.selftest","payload":{}}'
// Uses node:http, not fetch: fetch adds Sec-Fetch-* headers, which the API rejects as browser traffic.
import { request } from "node:http";
import { DEFAULT_API_PORT } from "@clipforge/shared";
import { signRequest } from "../src/auth.js";

const [method = "GET", path = "/api/v1/version", body = ""] = process.argv.slice(2);
const secret = process.env.CLIPFORGE_API_SECRET;
if (!secret || !/^[0-9a-f]{64}$/.test(secret)) {
  throw new Error("Set CLIPFORGE_API_SECRET (64 hex chars)");
}
const req = request(
  {
    host: "127.0.0.1",
    port: Number(process.env.CLIPFORGE_API_PORT ?? DEFAULT_API_PORT),
    method,
    path,
    headers: {
      ...signRequest(Buffer.from(secret, "hex"), method, path, body),
      ...(body && { "content-type": "application/json" }),
    },
  },
  (res) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (data += chunk));
    res.on("end", () => {
      console.log(res.statusCode, data);
    });
  },
);
req.end(body);
