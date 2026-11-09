import { FlaskConical, X } from "lucide-react";
import {
  jobListResponseSchema,
  jobResponseSchema,
  isTerminal,
  type JobView,
} from "@clipforge/shared";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { JobStatusBadge } from "@/features/system/JobStatusBadge";
import { useAction } from "@/features/system/useAction";
import { api } from "@/lib/ipc";
import { formatPercent, formatTime } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

const JOBS_POLL_MS = 1_500;

const listJobs = async (): Promise<readonly JobView[]> =>
  (await api("GET", "/api/v1/jobs?limit=50", jobListResponseSchema)).jobs;
const runSelftest = () =>
  api("POST", "/api/v1/jobs", jobResponseSchema, {
    kind: "system.selftest",
    payload: { durationMs: 20_000, steps: 20 },
  });
const cancelJob = (id: string) => api("POST", `/api/v1/jobs/${id}/cancel`, jobResponseSchema);

export function QueuePage() {
  const { result, refresh } = usePoll(listJobs, JOBS_POLL_MS);
  const create = useAction(runSelftest, refresh);
  const cancel = useAction(cancelJob, refresh);
  const jobs = result.state === "loading" ? undefined : result.data;

  return (
    <>
      <PageHeader title="Production Queue" description="Jobs and progress">
        <Button
          size="sm"
          onClick={() => {
            create.run();
          }}
          disabled={create.pending}
        >
          <FlaskConical aria-hidden />
          Run self-test job
        </Button>
      </PageHeader>
      <div className="space-y-4 p-8">
        {create.error !== null && (
          <ErrorNotice error={create.error} title="Could not create the job" />
        )}
        {cancel.error !== null && (
          <ErrorNotice error={cancel.error} title="Could not cancel the job" />
        )}
        {result.state === "error" && (
          <ErrorNotice error={result.error} title="Could not load jobs" />
        )}
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {result.state === "loading" && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {jobs?.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
            {jobs && jobs.length > 0 && (
              <ul className="divide-y" aria-label="Jobs">
                {jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    onCancel={cancel.run}
                    cancelling={cancel.pending}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function JobRow({
  job,
  onCancel,
  cancelling,
}: {
  job: JobView;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  return (
    <li className="space-y-2 py-3" data-testid="job-row">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{job.kind}</p>
          <p className="text-xs text-muted-foreground">
            {formatTime(job.createdAt)} · attempt {job.attempt}/{job.maxAttempts}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <JobStatusBadge status={job.status} />
          {!isTerminal(job.status) && !job.cancelRequested && job.status !== "failed" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onCancel(job.id);
              }}
              disabled={cancelling}
              aria-label={`Cancel job ${job.id}`}
            >
              <X aria-hidden />
              Cancel
            </Button>
          )}
        </div>
      </div>
      {job.status === "running" && (
        <Progress
          value={job.progress * 100}
          aria-label={`Progress ${formatPercent(job.progress)}`}
        />
      )}
      {job.error && (
        <p className="text-xs text-muted-foreground">
          {job.error.code}: {job.error.message}
        </p>
      )}
    </li>
  );
}
