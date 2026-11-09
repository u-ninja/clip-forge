import type { FastifyPluginCallback } from "fastify";
import {
  BackupError,
  backupDatabase,
  checkIntegrity,
  databaseInfo,
  listBackups,
  migrationStatus,
  stageRestore,
  type DatabaseHandle,
} from "@clipforge/database";
import { restoreRequestSchema } from "@clipforge/shared";
import { HttpError } from "../errors.js";
import { parseInput } from "../validation.js";

const BACKUP_ERROR_STATUS: Record<BackupError["code"], number> = {
  BACKUP_NOT_FOUND: 404,
  BACKUP_INVALID: 422,
  BACKUP_TOO_NEW: 422,
};

function asHttp(err: unknown): unknown {
  return err instanceof BackupError
    ? new HttpError(BACKUP_ERROR_STATUS[err.code], err.code, err.message)
    : err;
}

export const databaseRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  databasePath: string;
}> = (app, { database, databasePath }, done) => {
  app.get("/api/v1/database", (_req, reply) => {
    void reply.send({
      database: databaseInfo(database, databasePath),
      backups: listBackups(databasePath),
    });
  });

  app.post("/api/v1/database/backups", async (req, reply) => {
    try {
      const backup = await backupDatabase(database, databasePath, "manual");
      req.log.info(
        { operation: "db.backup", backup: backup.id, sizeBytes: backup.sizeBytes },
        "backup created",
      );
      return await reply.code(201).send({ backup });
    } catch (err) {
      throw asHttp(err);
    }
  });

  app.post("/api/v1/database/integrity-check", (req, reply) => {
    const result = checkIntegrity(database.sqlite, "full");
    req.log.info({ operation: "db.integrity", ok: result.ok }, "integrity check finished");
    void reply.send(result);
  });

  // Staged, not applied: the live database is replaced only at the next API start (with a pre-restore copy).
  app.post("/api/v1/database/restore", (req, reply) => {
    const { backupId } = parseInput(restoreRequestSchema, req.body);
    try {
      stageRestore(databasePath, backupId, migrationStatus(database.sqlite).available);
    } catch (err) {
      throw asHttp(err);
    }
    req.log.warn(
      { operation: "db.restore-staged", backup: backupId },
      "restore staged for next start",
    );
    void reply.code(202).send({ restartRequired: true });
  });

  done();
};
