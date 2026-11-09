export const APP_NAME = "clipforge-local";
/** Reverse-DNS id; also names the OS user-data directory. Must match tauri.conf.json `identifier`. */
export const APP_ID = "com.clipforge.local";
/** Identifiers used before the rename. Only for one-time data migration; never write to these. */
export const LEGACY_APP_IDS = ["com.youtubeclipper.desktop"] as const;

export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 4317;
export const DEFAULT_WORKER_PORT = 4318;
