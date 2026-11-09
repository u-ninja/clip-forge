import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDashed, CircleX, Loader } from "lucide-react";
import type { JobStatus } from "@clipforge/shared";
import { Badge } from "@/components/ui/badge";

// Icon + text so status never relies on color alone.
export const JOB_STATUS_DISPLAY: Record<
  JobStatus,
  { label: string; icon: LucideIcon; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  queued: { label: "Queued", icon: CircleDashed, variant: "outline" },
  running: { label: "Running", icon: Loader, variant: "default" },
  paused: { label: "Paused", icon: CircleDashed, variant: "secondary" },
  succeeded: { label: "Done", icon: CircleCheck, variant: "secondary" },
  failed: { label: "Failed", icon: CircleX, variant: "destructive" },
  cancelled: { label: "Cancelled", icon: CircleX, variant: "outline" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = JOB_STATUS_DISPLAY[status];
  return (
    <Badge variant={s.variant}>
      <s.icon aria-hidden />
      {s.label}
    </Badge>
  );
}
