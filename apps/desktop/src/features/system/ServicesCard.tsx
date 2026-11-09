import { Play, RotateCw, Square } from "lucide-react";
import type { ServiceStatus } from "@clipforge/shared";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { runtime } from "@/lib/ipc";
import { ServiceBadge } from "./ServiceBadge";
import { useAction } from "./useAction";
import { useRuntimeStatus } from "./useRuntimeStatus";

/** Live status of the local services, with controls when `controls` is set (Settings). */
export function ServicesCard({ controls = false }: { controls?: boolean }) {
  const { status, refresh } = useRuntimeStatus();
  const restartApi = useAction(runtime.restartApi, refresh);
  const startWorker = useAction(runtime.startWorker, refresh);
  const stopWorker = useAction(runtime.stopWorker, refresh);
  const data = status.state === "loading" ? undefined : status.data;
  const worker = data?.worker;
  const workerUp = worker?.state === "running" || worker?.state === "starting";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local services</CardTitle>
        <CardDescription>Live status{data ? ` · ${data.mode} mode` : ""}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.state === "error" && (
          <ErrorNotice error={status.error} title="Runtime unavailable" />
        )}
        <ServiceRow label="API" status={data?.api}>
          {controls && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                restartApi.run();
              }}
              disabled={restartApi.pending}
            >
              <RotateCw aria-hidden />
              Restart
            </Button>
          )}
        </ServiceRow>
        <ServiceRow label="AI worker" status={worker} idleHint="Starts on demand">
          {controls &&
            (workerUp ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  stopWorker.run();
                }}
                disabled={stopWorker.pending}
              >
                <Square aria-hidden />
                Stop
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  startWorker.run();
                }}
                disabled={startWorker.pending}
              >
                <Play aria-hidden />
                Start
              </Button>
            ))}
        </ServiceRow>
        {[restartApi.error, startWorker.error, stopWorker.error].filter(Boolean).map((e, i) => (
          <ErrorNotice key={i} error={e} title="Action failed" />
        ))}
      </CardContent>
    </Card>
  );
}

function ServiceRow({
  label,
  status,
  idleHint,
  children,
}: {
  label: string;
  status: ServiceStatus | undefined;
  idleHint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1" data-testid={`service-${label}`}>
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <div className="flex items-center gap-2">
          <ServiceBadge status={status} />
          {children}
        </div>
      </div>
      {status?.state === "failed" && <p className="text-xs text-destructive">{status.reason}</p>}
      {status?.state === "stopped" && idleHint && (
        <p className="text-xs text-muted-foreground">{idleHint}</p>
      )}
    </div>
  );
}
