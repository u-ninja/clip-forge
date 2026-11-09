import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { JOB_KINDS, JOB_STATUSES, type JobErrorInfo } from "@clipforge/shared";

// Timestamps are unix epoch milliseconds. The DB default covers raw inserts; $onUpdate covers ORM updates.
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdate(() => new Date()),
};
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const json = (name: string) => text(name, { mode: "json" }).$type<Record<string, unknown>>();
const jobStatus = () => text("status", { enum: JOB_STATUSES }).notNull().default("queued");

// Fields shared by every resumable job table. lease_* lets a restarted process detect and requeue orphaned work.
const jobFields = {
  status: jobStatus(),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  progress: real("progress").notNull().default(0),
  checkpoint: json("checkpoint"),
  lastError: text("last_error"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
};

export const channels = sqliteTable("channels", {
  id: id(),
  name: text("name").notNull(),
  handle: text("handle"),
  // OAuth tokens never live here; they go to the OS credential store keyed by this id.
  youtubeChannelId: text("youtube_channel_id").unique(),
  status: text("status", { enum: ["active", "paused", "archived"] })
    .notNull()
    .default("active"),
  weeklyTarget: integer("weekly_target").notNull().default(0),
  ...timestamps,
});

export const channelProfiles = sqliteTable("channel_profiles", {
  id: id(),
  channelId: text("channel_id")
    .notNull()
    .unique()
    .references(() => channels.id, { onDelete: "cascade" }),
  niche: text("niche"),
  tone: text("tone"),
  language: text("language").notNull().default("en"),
  targetDurationSec: integer("target_duration_sec"),
  styleGuide: json("style_guide"),
  ...timestamps,
});

export const contentIdeas = sqliteTable(
  "content_ideas",
  {
    id: id(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status", { enum: ["new", "approved", "rejected", "in_production", "done"] })
      .notNull()
      .default("new"),
    score: real("score"),
    ...timestamps,
  },
  (t) => [index("content_ideas_channel_status_idx").on(t.channelId, t.status)],
);

export const sources = sqliteTable("sources", {
  id: id(),
  channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["url", "file", "creator_video"] }).notNull(),
  uri: text("uri").notNull(),
  title: text("title"),
  metadata: json("metadata"),
  ...timestamps,
});

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: id(),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["video", "audio", "image", "subtitle", "font"] }).notNull(),
    // Relative to the managed storage root, never absolute, so the library survives moves and OS changes.
    storagePath: text("storage_path").notNull().unique(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull(),
    durationMs: integer("duration_ms"),
    ...timestamps,
  },
  (t) => [index("media_assets_sha256_idx").on(t.sha256)],
);

export const mediaRights = sqliteTable(
  "media_rights",
  {
    id: id(),
    mediaAssetId: text("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    licenseType: text("license_type", {
      enum: ["owned", "licensed", "creative_commons", "public_domain", "permission", "unknown"],
    })
      .notNull()
      .default("unknown"),
    licensor: text("licensor"),
    licenseUrl: text("license_url"),
    attribution: text("attribution"),
    allowsCommercialUse: integer("allows_commercial_use", { mode: "boolean" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("media_rights_asset_idx").on(t.mediaAssetId)],
);

export const productionJobs = sqliteTable(
  "production_jobs",
  {
    id: id(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    contentIdeaId: text("content_idea_id").references(() => contentIdeas.id, {
      onDelete: "set null",
    }),
    stage: text("stage", { enum: ["scripting", "voiceover", "rendering", "review", "publishing"] })
      .notNull()
      .default("scripting"),
    idempotencyKey: text("idempotency_key").unique(),
    ...jobFields,
    ...timestamps,
  },
  (t) => [
    index("production_jobs_status_idx").on(t.status),
    index("production_jobs_channel_idx").on(t.channelId),
  ],
);

export const scripts = sqliteTable(
  "scripts",
  {
    id: id(),
    productionJobId: text("production_job_id")
      .notNull()
      .references(() => productionJobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    title: text("title"),
    body: text("body").notNull(),
    wordCount: integer("word_count"),
    status: text("status", { enum: ["draft", "approved", "rejected"] })
      .notNull()
      .default("draft"),
    ...timestamps,
  },
  (t) => [uniqueIndex("scripts_job_version_uq").on(t.productionJobId, t.version)],
);

export const voiceovers = sqliteTable(
  "voiceovers",
  {
    id: id(),
    productionJobId: text("production_job_id")
      .notNull()
      .references(() => productionJobs.id, { onDelete: "cascade" }),
    scriptId: text("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    mediaAssetId: text("media_asset_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    engine: text("engine").notNull(),
    voice: text("voice"),
    durationMs: integer("duration_ms"),
    ...jobFields,
    ...timestamps,
  },
  (t) => [index("voiceovers_job_idx").on(t.productionJobId)],
);

export const renderJobs = sqliteTable(
  "render_jobs",
  {
    id: id(),
    productionJobId: text("production_job_id")
      .notNull()
      .references(() => productionJobs.id, { onDelete: "cascade" }),
    outputAssetId: text("output_asset_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    format: text("format", { enum: ["long_form", "short"] }).notNull(),
    settings: json("settings"),
    ...jobFields,
    ...timestamps,
  },
  (t) => [
    index("render_jobs_status_idx").on(t.status),
    index("render_jobs_job_idx").on(t.productionJobId),
  ],
);

export const publishingJobs = sqliteTable(
  "publishing_jobs",
  {
    id: id(),
    productionJobId: text("production_job_id")
      .notNull()
      .references(() => productionJobs.id, { onDelete: "cascade" }),
    renderJobId: text("render_job_id")
      .notNull()
      .references(() => renderJobs.id, { onDelete: "restrict" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    // Default private: nothing goes public without an explicit decision.
    visibility: text("visibility", { enum: ["private", "unlisted", "public"] })
      .notNull()
      .default("private"),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    youtubeVideoId: text("youtube_video_id"),
    idempotencyKey: text("idempotency_key").unique(),
    ...jobFields,
    ...timestamps,
  },
  (t) => [index("publishing_jobs_status_idx").on(t.status)],
);

/**
 * Durable execution queue (ADR-011). Domain tables describe *what* to produce; a row here is one
 * unit of execution with its lease, retries and progress. SQLite is the source of truth.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    payload: json("payload").notNull().default({}),
    status: jobStatus(),
    priority: integer("priority").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    progress: real("progress").notNull().default(0),
    idempotencyKey: text("idempotency_key").unique(),
    // Earliest time the job may be claimed; pushed forward by retry backoff.
    runAfter: integer("run_after", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    error: text("error", { mode: "json" }).$type<JobErrorInfo>(),
    result: json("result"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAfter, t.priority),
    index("jobs_lease_idx").on(t.status, t.leaseExpiresAt),
  ],
);
