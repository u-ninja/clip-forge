import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { DatabaseHandle } from "@clipforge/database";
import type { ApiError } from "@clipforge/shared";
import { ReplayGuard, precheck, verify, type AuthFailure } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { defaultHandlers, type JobHandler } from "./jobs/handlers.js";
import { DEFAULT_RUNNER_OPTIONS, JobRunner, type RunnerOptions } from "./jobs/runner.js";
import type { JobKind } from "@clipforge/shared";
import type { JobStore } from "./jobs/store.js";
import { databaseRoutes } from "./routes/database.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { jobRoutes } from "./routes/jobs.js";
import { systemRoutes } from "./routes/system.js";

// Anything can be thrown; only Fastify's own errors are guaranteed to carry these fields.
type ThrownError = Error & Partial<Pick<FastifyError, "statusCode" | "code">>;

const BODY_LIMIT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** Headers browsers attach to every fetch; the only legitimate client (the Rust runtime) sends none. */
const BROWSER_HEADERS = ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] as const;

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    readonly runner: JobRunner;
  }
  interface FastifyContextConfig {
    /** Route needs no session signature. Only `/health` sets this. */
    public?: boolean;
  }
}

export interface AppInfo {
  readonly name: string;
  readonly version: string;
}

export interface AppDeps {
  readonly database: DatabaseHandle;
  readonly databasePath: string;
  readonly jobs: JobStore;
  readonly handlers?: Readonly<Record<JobKind, JobHandler>>;
  readonly runnerOptions?: Partial<RunnerOptions>;
  readonly now?: () => number;
}

export async function buildApp(
  config: ApiConfig,
  info: AppInfo,
  deps: AppDeps,
): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { service: "api" },
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-clipforge-signature']",
      ],
      // Pretty output only for a human at a terminal; under the desktop runtime logs stay JSON.
      ...(config.env === "development" &&
        process.stdout.isTTY && { transport: { target: "pino-pretty" } }),
    },
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Correlation ids from the runtime are accepted only in a safe shape (no log injection).
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && REQUEST_ID_PATTERN.test(given) ? given : randomUUID();
    },
    return503OnClosing: true,
  });

  // Keep the raw bytes: the signature covers the exact body that was sent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, body.length === 0 ? undefined : JSON.parse(body.toString("utf8")));
    } catch {
      done(
        Object.assign(new Error("Malformed JSON body"), { statusCode: 400, code: "BAD_REQUEST" }),
      );
    }
  });

  // DNS-rebinding guard: a loopback bind alone doesn't stop a web page from reaching us via a hostile hostname.
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    `[::1]:${config.port}`,
  ]);
  const guard = new ReplayGuard();
  const deny = (failure: AuthFailure, req: { log: FastifyInstance["log"]; id: string }) => {
    // The reason is logged for diagnostics but never returned: clients learn only "unauthorized".
    req.log.warn({ operation: "auth", reason: failure }, "request rejected");
    return failure === "overloaded"
      ? { status: 429, body: errorBody("RATE_LIMITED", "Too many requests", req.id) }
      : { status: 401, body: errorBody("UNAUTHORIZED", "Authentication required", req.id) };
  };

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    if (!allowedHosts.has(req.headers.host ?? "")) {
      return reply.code(421).send(errorBody("MISDIRECTED_REQUEST", "Host not allowed", req.id));
    }
    // No CORS: browsers and webviews never talk to the API directly (ADR-010).
    if (BROWSER_HEADERS.some((h) => req.headers[h] !== undefined)) {
      return reply
        .code(403)
        .send(errorBody("FORBIDDEN", "Browser requests are not accepted", req.id));
    }
    if (req.routeOptions.config.public === true) return;
    const failure = precheck(req.headers, now());
    if (failure) {
      const { status, body } = deny(failure, req);
      return reply.code(status).send(body);
    }
  });

  app.addHook("preValidation", async (req, reply) => {
    if (req.routeOptions.config.public === true) return;
    const failure = verify(
      config.secret,
      guard,
      req.method,
      req.url,
      req.headers,
      req.rawBody ?? "",
      now(),
    );
    if (failure) {
      const { status, body } = deny(failure, req);
      return reply.code(status).send(body);
    }
  });

  app.setErrorHandler<ThrownError>((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    // Never leak internals on 5xx; client errors carry our own (or Fastify's) safe message.
    const message = status >= 500 ? "Internal server error" : err.message;
    const code = status >= 500 ? "INTERNAL" : (err.code ?? "BAD_REQUEST");
    return reply.code(status).send(errorBody(code, message, req.id));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody("NOT_FOUND", "Route not found", req.id)),
  );

  // Started by the server after listen(); stopped before the database closes.
  const runner = new JobRunner(
    deps.jobs,
    deps.handlers ?? defaultHandlers,
    { ...DEFAULT_RUNNER_OPTIONS, concurrency: config.jobConcurrency, ...deps.runnerOptions },
    app.log.child({ component: "jobs" }),
  );
  app.decorate("runner", runner);

  await app.register(systemRoutes, { info });
  await app.register(jobRoutes, { store: deps.jobs, runner });
  await app.register(databaseRoutes, { database: deps.database, databasePath: deps.databasePath });
  await app.register(diagnosticsRoutes, { info, ...deps, runner });
  return app;
}

export function errorBody(code: string, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}
