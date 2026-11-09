import type { RuntimeStatus } from "@clipforge/shared";
import { runtime } from "@/lib/ipc";
import { usePoll, type PollState } from "@/lib/usePoll";

const STATUS_POLL_MS = 2_000;

/** Live service status from the Rust runtime (cheap: served from memory, no HTTP). */
export function useRuntimeStatus(): { status: PollState<RuntimeStatus>; refresh: () => void } {
  const { result, refresh } = usePoll(runtime.status, STATUS_POLL_MS);
  return { status: result, refresh };
}
