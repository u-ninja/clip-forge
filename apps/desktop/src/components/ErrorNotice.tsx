import { CircleAlert } from "lucide-react";
import { errorMessage } from "@/lib/ipc";

/** Inline, accessible error message. `role="alert"` announces it to screen readers. */
export function ErrorNotice({
  error,
  title = "Something went wrong",
}: {
  error: unknown;
  title?: string;
}) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{errorMessage(error)}</p>
      </div>
    </div>
  );
}
