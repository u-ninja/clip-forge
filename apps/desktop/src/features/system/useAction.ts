import { useCallback, useState } from "react";

/** Runs a user action once at a time (guards double clicks) and keeps its last error. */
export function useAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown>,
  onDone?: () => void,
): { run: (...args: A) => void; pending: boolean; error: unknown } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    (...args: A) => {
      if (pending) return;
      setPending(true);
      setError(null);
      action(...args)
        .catch((err: unknown) => {
          setError(err);
        })
        .finally(() => {
          setPending(false);
          onDone?.();
        });
    },
    [action, onDone, pending],
  );
  return { run, pending, error };
}
