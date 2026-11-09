export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed, half random.
 * Keeps retries spread out (no thundering herd) while guaranteeing a minimum wait.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}
