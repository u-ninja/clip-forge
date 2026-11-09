import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createJobRequestSchema, jobListQuerySchema } from "@clipforge/shared";
import { HttpError } from "../errors.js";
import { defaultHandlers } from "../jobs/handlers.js";
import type { JobRunner } from "../jobs/runner.js";
import type { JobStore } from "../jobs/store.js";
import { parseInput } from "../validation.js";

const idParams = z.object({ id: z.uuid() });

export const jobRoutes: FastifyPluginCallback<{ store: JobStore; runner: JobRunner }> = (
  app,
  { store, runner },
  done,
) => {
  app.post("/api/v1/jobs", (req, reply) => {
    const body = parseInput(createJobRequestSchema, req.body);
    const payload = parseInput(defaultHandlers[body.kind].payloadSchema, body.payload);
    const { job, created } = store.enqueue({ ...body, payload });
    if (created) {
      req.log.info({ jobId: job.id, kind: job.kind, operation: "job.enqueue" }, "job queued");
      runner.kick();
    }
    void reply.code(created ? 201 : 200).send({ job });
  });

  app.get("/api/v1/jobs", (req, reply) => {
    const query = parseInput(jobListQuerySchema, req.query);
    void reply.send({ jobs: store.list(query.status, query.limit) });
  });

  app.get("/api/v1/jobs/:id", (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const job = store.get(id);
    if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found");
    void reply.send({ job });
  });

  app.post("/api/v1/jobs/:id/cancel", (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const job = store.requestCancel(id);
    if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found");
    req.log.info({ jobId: id, operation: "job.cancel-request" }, "cancellation requested");
    void reply.send({ job });
  });

  done();
};
