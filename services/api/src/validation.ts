import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Validates untrusted input; failures become a 400 with field paths only (no echoed values). */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid request: ${fields}`);
  }
  return result.data;
}
