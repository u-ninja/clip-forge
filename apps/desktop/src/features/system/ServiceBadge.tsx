import { CircleCheck, CircleDashed, CircleStop, CircleX, Loader } from "lucide-react";
import type { ServiceStatus } from "@clipforge/shared";
import { Badge } from "@/components/ui/badge";

/** Icon + text so status never relies on color alone. */
export function ServiceBadge({ status }: { status: ServiceStatus | undefined }) {
  switch (status?.state) {
    case undefined:
      return (
        <Badge variant="outline">
          <CircleDashed aria-hidden />
          Unknown
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          <CircleCheck aria-hidden />
          Online
        </Badge>
      );
    case "starting":
      return (
        <Badge variant="outline">
          <Loader aria-hidden className="animate-spin" />
          Starting
        </Badge>
      );
    case "stopping":
      return (
        <Badge variant="outline">
          <Loader aria-hidden className="animate-spin" />
          Stopping
        </Badge>
      );
    case "stopped":
      return (
        <Badge variant="outline">
          <CircleStop aria-hidden />
          Offline
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" title={status.reason}>
          <CircleX aria-hidden />
          Failed
        </Badge>
      );
  }
}
