import type { LucideIcon } from "lucide-react";
import { Activity, CalendarCheck, Tv, Upload } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { JOB_STATUS_DISPLAY } from "@/features/system/JobStatusBadge";
import { ServicesCard } from "@/features/system/ServicesCard";
import { mockActivity, mockPipeline, mockSummary } from "./mock-data";

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const formatAgo = (d: Date) => {
  const minutes = Math.round((d.getTime() - Date.now()) / 60_000);
  return Math.abs(minutes) < 60
    ? relativeTime.format(minutes, "minute")
    : relativeTime.format(Math.round(minutes / 60), "hour");
};

export function DashboardPage() {
  const { weeklyTarget } = mockSummary;
  const pipelineMax = Math.max(1, ...mockPipeline.map((p) => p.count));

  return (
    <>
      <PageHeader title="Dashboard" description="Production overview">
        <Badge variant="outline">Sample data</Badge>
      </PageHeader>

      <div className="grid gap-4 p-8 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Tv} label="Active channels" value={mockSummary.activeChannels} />
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <CalendarCheck className="size-4" aria-hidden />
              Weekly target
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {weeklyTarget.completed} / {weeklyTarget.target}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress
              value={(weeklyTarget.completed / weeklyTarget.target) * 100}
              aria-label="Weekly target progress"
            />
          </CardContent>
        </Card>
        <Stat icon={Activity} label="Jobs in progress" value={mockSummary.jobsInProgress} />
        <Stat icon={Upload} label="Published videos" value={mockSummary.publishedVideos} />

        <Card className="sm:col-span-2">
          <CardHeader>
            <CardTitle>Recent production activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {mockActivity.map((a) => {
                const s = JOB_STATUS_DISPLAY[a.status];
                return (
                  <li key={a.id} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.channel} · {a.stage} · {formatAgo(a.at)}
                      </p>
                    </div>
                    <Badge variant={s.variant}>
                      <s.icon aria-hidden />
                      {s.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline status</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {mockPipeline.map((p) => (
                <li key={p.stage} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>{p.stage}</span>
                    <span className="tabular-nums text-muted-foreground">{p.count}</span>
                  </div>
                  <Progress
                    value={(p.count / pipelineMax) * 100}
                    aria-label={`${p.stage}: ${p.count} jobs`}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Real application state: the only live data on this screen. */}
        <ServicesCard />
      </div>
    </>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Icon className="size-4" aria-hidden />
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
  );
}
