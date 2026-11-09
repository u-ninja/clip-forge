import { useCallback, useEffect, useRef, useState } from "react";

export type PollState<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: T }
  | { readonly state: "error"; readonly error: unknown; readonly data?: T };

/**
 * Runs `load` now and every `intervalMs` while the window is visible (pass 0 for one-shot).
 * Never overlaps requests; ignores results after unmount.
 */
export function usePoll<T>(
  load: () => Promise<T>,
  intervalMs: number,
): { result: PollState<T>; refresh: () => void } {
  const [result, setResult] = useState<PollState<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const data = await loadRef.current();
        if (!cancelled) setResult({ state: "ready", data });
      } catch (error) {
        if (!cancelled) {
          setResult((prev) => ({
            state: "error",
            error,
            data: prev.state === "loading" ? undefined : prev.data,
          }));
        }
      }
      if (!cancelled && intervalMs > 0) {
        timer = setTimeout(() => {
          if (document.visibilityState === "visible") void run();
          else timer = setTimeout(() => void run(), intervalMs);
        }, intervalMs);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [intervalMs, tick]);

  return {
    result,
    refresh: useCallback(() => {
      setTick((n) => n + 1);
    }, []),
  };
}
