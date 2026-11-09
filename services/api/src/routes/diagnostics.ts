import type { FastifyPluginCallback } from "fastify";
import { databaseInfo } from "@clipforge/database";
import type { ApiDiagnostics } from "@clipforge/shared";
import type { AppDeps, AppInfo } from "../app.js";
import type { JobRunner } from "../jobs/runner.js";

export const diagnosticsRoutes: FastifyPluginCallback<
  AppDeps & { info: AppInfo; runner: JobRunner }
> = (app, opts, done) => {
  app.get<{ Reply: ApiDiagnostics }>("/api/v1/diagnostics", (_req, reply) => {
    const mem = process.memoryUsage();
    void reply.send({
      api: {
        version: opts.info.version,
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
      database: databaseInfo(opts.database, opts.databasePath),
      jobs: {
        counts: opts.jobs.counts(),
        concurrency: opts.runner.concurrency,
        active: opts.runner.activeCount,
      },
    });
  });
  done();
};
