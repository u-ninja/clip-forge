import type { FastifyPluginCallback } from "fastify";
import type { HealthResponse, VersionResponse } from "@clipforge/shared";
import type { AppInfo } from "../app.js";

export const systemRoutes: FastifyPluginCallback<{ info: AppInfo }> = (app, { info }, done) => {
  app.get<{ Reply: HealthResponse }>("/health", (_req, reply) => {
    void reply.send({ status: "ok", service: "api", uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get<{ Reply: VersionResponse }>("/api/version", (_req, reply) => {
    void reply.send({ name: info.name, version: info.version, node: process.version });
  });

  done();
};
