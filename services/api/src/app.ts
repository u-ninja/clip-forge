import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

// Anything can be thrown; only Fastify's own errors are guaranteed to carry these fields.
type ThrownError = Error & Partial<Pick<FastifyError, "statusCode" | "code">>;
import cors from "@fastify/cors";
import { DESKTOP_ORIGINS, type ApiError } from "@clipforge/shared";
import type { ApiConfig } from "./config.js";
import { systemRoutes } from "./routes/system.js";

const BODY_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface AppInfo {
  readonly name: string;
  readonly version: string;
}

export async function buildApp(config: ApiConfig, info: AppInfo): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { service: "api" },
      redact: ["req.headers.authorization", "req.headers.cookie"],
      ...(config.env === "development" && { transport: { target: "pino-pretty" } }),
    },
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    return503OnClosing: true,
  });

  // DNS-rebinding guard: a loopback bind alone doesn't stop a web page from reaching us via a hostile hostname.
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    `[::1]:${config.port}`,
  ]);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (!allowedHosts.has(req.headers.host ?? "")) {
      return reply.code(421).send(errorBody("MISDIRECTED_REQUEST", "Host not allowed", req.id));
    }
  });

  await app.register(cors, {
    origin: [...DESKTOP_ORIGINS],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  app.setErrorHandler<ThrownError>((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    // Never leak internals on 5xx; client errors carry Fastify's own safe message.
    const message = status >= 500 ? "Internal server error" : err.message;
    return reply.code(status).send(errorBody(err.code ?? "INTERNAL", message, req.id));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody("NOT_FOUND", "Route not found", req.id)),
  );

  await app.register(systemRoutes, { info });
  return app;
}

function errorBody(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}
