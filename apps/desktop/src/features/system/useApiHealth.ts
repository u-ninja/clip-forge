import { useCallback, useEffect, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@clipforge/shared";
import { API_BASE_URL } from "@/config";

const HEALTH_TIMEOUT_MS = 3_000;

export type ApiHealth =
  | { readonly state: "checking" }
  | { readonly state: "online"; readonly health: HealthResponse }
  | { readonly state: "offline"; readonly reason: string };

/** One-shot health check with manual refresh. No background polling. */
export function useApiHealth(): { health: ApiHealth; refresh: () => void } {
  const [health, setHealth] = useState<ApiHealth>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, HEALTH_TIMEOUT_MS);
    fetch(`${API_BASE_URL}/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (cancelled) return;
        setHealth({ state: "online", health: healthResponseSchema.parse(body) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const reason = controller.signal.aborted
          ? "Timed out"
          : err instanceof Error
            ? err.message
            : "Unreachable";
        setHealth({ state: "offline", reason });
      })
      .finally(() => {
        clearTimeout(timer);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt]);

  return {
    health,
    refresh: useCallback(() => {
      setAttempt((n) => n + 1);
    }, []),
  };
}
