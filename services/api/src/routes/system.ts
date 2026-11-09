import type { FastifyPluginCallback } from "fastify";
import type { HealthResponse, VersionResponse } from "@clipforge/shared";
import type { AppInfo } from "../app.js";

export const systemRoutes: FastifyPluginCallback<{ info: AppInfo }> = (app, { info }, done) => {
  // Unauthenticated by design and deliberately uninformative: readiness only.
  app.get<{ Reply: HealthResponse }>("/health", { config: { public: true } }, (_req, reply) => {
    void reply.send({ status: "ok", service: "api" });
  });

  app.get<{ Reply: VersionResponse }>("/api/v1/version", (_req, reply) => {
    void reply.send({ name: info.name, version: info.version, node: process.version });
  });

  done();
};
