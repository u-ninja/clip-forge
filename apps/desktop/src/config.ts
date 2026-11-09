import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "@clipforge/shared";

// Only non-secret values belong in VITE_* variables: they are compiled into the frontend bundle.
export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL ?? `http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT}`;
