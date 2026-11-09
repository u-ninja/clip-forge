import { useCallback, useState } from "react";
import { Database, Download, RefreshCw, ShieldCheck } from "lucide-react";
import {
  databaseResponseSchema,
  integrityResultSchema,
  type BackupInfo,
  type DiagnosticsReport,
  type IntegrityResult,
} from "@clipforge/shared";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ServiceBadge } from "@/features/system/ServiceBadge";
import { useAction } from "@/features/system/useAction";
import { api, runtime } from "@/lib/ipc";
import { formatBytes, formatTime } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";
import { z } from "zod";

const REPORT_POLL_MS = 5_000;

export function DiagnosticsPage() {
  const { result, refresh } = usePoll(runtime.diagnostics, REPORT_POLL_MS);
  const [exported, setExported] = useState<string | null>(null);
  const exportReport = useAction(
    useCallback(async () => {
      setExported(await runtime.exportDiagnostics());
    }, []),
  );
  const report = result.state === "loading" ? undefined : result.data;

  return (
    <>
      <PageHeader title="Diagnostics" description="Runtime health, resources and recent errors">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw aria-hidden />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              exportReport.run();
            }}
            disabled={exportReport.pending || !report}
          >
            <Download aria-hidden />
            Export report
          </Button>
        </div>
      </PageHeader>
      <div className="grid gap-4 p-8 lg:grid-cols-2">
        {exported && (
          <p role="status" className="text-sm lg:col-span-2">
            Report saved to <code>{exported}</code>. It contains no credentials or file contents.
          </p>
        )}
        {exportReport.error !== null && (
          <ErrorNotice error={exportReport.error} title="Export failed" />
        )}
        {result.state === "error" && (
          <div className="lg:col-span-2">
            <ErrorNotice error={result.error} title="Diagnostics unavailable" />
          </div>
        )}
        {result.state === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
        {report && <ReportCards report={report} />}
        {report?.runtime.api.state === "running" && <DatabaseCard />}
      </div>
    </>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportCards({ report }: { report: DiagnosticsReport }) {
  const r = report.resources;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
        </CardHeader>
        <CardContent>
          <Rows
            rows={[
              ["Version", `${report.app.version} (${report.app.mode})`],
              ["Operating system", `${report.os.name} ${report.os.version} (${report.os.arch})`],
              ["API", <ServiceBadge key="api" status={report.runtime.api} />],
              ["Worker", <ServiceBadge key="worker" status={report.runtime.worker} />],
              [
                "Database",
                report.api
                  ? `${report.api.database.path} · schema v${report.api.database.schemaVersion}`
                  : (report.apiError ?? "Unknown"),
              ],
              [
                "Jobs",
                report.api
                  ? `${report.api.jobs.counts.running} running · ${report.api.jobs.counts.queued} queued`
                  : "Unknown",
              ],
              [
                "Logs",
                `${report.logs.directory} · ${formatBytes(report.logs.totalBytes)} of ${formatBytes(report.logs.maxBytes)}, ${report.logs.retentionDays} days`,
              ],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Rows
            rows={[
              [
                "CPU",
                `${r.cpuBrand || "Unknown"} · ${r.cpuCount} cores · ${Math.round(r.globalCpuPercent)}% busy`,
              ],
              [
                "Memory",
                `${formatBytes(r.availableMemoryBytes)} free of ${formatBytes(r.totalMemoryBytes)}`,
              ],
              [
                "Disk",
                r.diskAvailableBytes !== null && r.diskTotalBytes !== null
                  ? `${formatBytes(r.diskAvailableBytes)} free of ${formatBytes(r.diskTotalBytes)}`
                  : "Unknown",
              ],
            ]}
          />
          <table className="w-full text-sm">
            <caption className="sr-only">Processes</caption>
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="font-normal">Process</th>
                <th className="font-normal">PID</th>
                <th className="text-right font-normal">Memory</th>
                <th className="text-right font-normal">CPU</th>
              </tr>
            </thead>
            <tbody>
              {r.processes.map((p) => (
                <tr key={p.pid}>
                  <td>{p.name}</td>
                  <td className="tabular-nums">{p.pid}</td>
                  <td className="text-right tabular-nums">{formatBytes(p.memoryBytes)}</td>
                  <td className="text-right tabular-nums">{Math.round(p.cpuPercent)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Recent errors</CardTitle>
        </CardHeader>
        <CardContent>
          {report.recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No warnings or errors this session.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs" aria-label="Recent errors">
              {[...report.recentErrors].reverse().map((e, i) => (
                <li key={`${e.time}-${i}`}>
                  <span className="text-muted-foreground">{formatTime(e.time)}</span> [{e.service}/
                  {e.level}] {e.message}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const loadDatabase = () => api("GET", "/api/v1/database", databaseResponseSchema);
const backupNow = () => api("POST", "/api/v1/database/backups", z.object({ backup: z.unknown() }));
const integrityCheck = () => api("POST", "/api/v1/database/integrity-check", integrityResultSchema);
const stageRestore = (backupId: string) =>
  api("POST", "/api/v1/database/restore", z.object({ restartRequired: z.literal(true) }), {
    backupId,
    confirm: true,
  });

function DatabaseCard() {
  const { result, refresh } = usePoll(loadDatabase, 0);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const backup = useAction(backupNow, refresh);
  const check = useAction(
    useCallback(async () => {
      setIntegrity(await integrityCheck());
    }, []),
  );
  const restore = useAction(
    useCallback(async (id: string) => {
      await stageRestore(id);
      setConfirming(null);
      await runtime.restartApi();
    }, []),
    refresh,
  );
  const db = result.state === "loading" ? undefined : result.data;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Database</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {db && (
          <Rows
            rows={[
              ["Location", db.database.path],
              ["Size", formatBytes(db.database.sizeBytes)],
              [
                "Schema version",
                `${db.database.schemaVersion} of ${db.database.availableMigrations}`,
              ],
              [
                "SQLite",
                `${db.database.sqliteVersion} · ${db.database.journalMode} · foreign keys ${db.database.foreignKeys ? "on" : "off"}`,
              ],
            ]}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              backup.run();
            }}
            disabled={backup.pending}
          >
            <Database aria-hidden />
            Back up now
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              check.run();
            }}
            disabled={check.pending}
          >
            <ShieldCheck aria-hidden />
            Check integrity
          </Button>
        </div>
        {integrity && (
          <p role="status" className="text-sm">
            Integrity check{" "}
            {integrity.ok ? "passed" : `found problems: ${integrity.problems.join("; ")}`}.
          </p>
        )}
        {[backup.error, check.error, restore.error, result.state === "error" ? result.error : null]
          .filter((e) => e !== null)
          .map((e, i) => (
            <ErrorNotice key={i} error={e} title="Database operation failed" />
          ))}
        {db && db.backups.length > 0 && (
          <ul className="divide-y text-sm" aria-label="Backups">
            {db.backups.map((b: BackupInfo) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {formatTime(b.createdAt)} · {b.label} · {formatBytes(b.sizeBytes)}
                </span>
                {confirming === b.id ? (
                  <span className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        restore.run(b.id);
                      }}
                      disabled={restore.pending}
                    >
                      Restore and restart API
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Keep current data
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirming(b.id);
                    }}
                  >
                    Restore…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Restoring keeps a copy of the current database as a “pre-restore” backup.
        </p>
      </CardContent>
    </Card>
  );
}
