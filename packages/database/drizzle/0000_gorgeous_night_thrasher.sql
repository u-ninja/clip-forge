CREATE TABLE `channel_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`niche` text,
	`tone` text,
	`language` text DEFAULT 'en' NOT NULL,
	`target_duration_sec` integer,
	`style_guide` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_profiles_channel_id_unique` ON `channel_profiles` (`channel_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`handle` text,
	`youtube_channel_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`weekly_target` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_youtube_channel_id_unique` ON `channels` (`youtube_channel_id`);--> statement-breakpoint
CREATE TABLE `content_ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`status` text DEFAULT 'new' NOT NULL,
	`score` real,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_ideas_channel_status_idx` ON `content_ideas` (`channel_id`,`status`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`kind` text NOT NULL,
	`storage_path` text NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer NOT NULL,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_storage_path_unique` ON `media_assets` (`storage_path`);--> statement-breakpoint
CREATE INDEX `media_assets_sha256_idx` ON `media_assets` (`sha256`);--> statement-breakpoint
CREATE TABLE `media_rights` (
	`id` text PRIMARY KEY NOT NULL,
	`media_asset_id` text NOT NULL,
	`license_type` text DEFAULT 'unknown' NOT NULL,
	`licensor` text,
	`license_url` text,
	`attribution` text,
	`allows_commercial_use` integer,
	`expires_at` integer,
	`verified_at` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_rights_asset_idx` ON `media_rights` (`media_asset_id`);--> statement-breakpoint
CREATE TABLE `production_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`content_idea_id` text,
	`stage` text DEFAULT 'scripting' NOT NULL,
	`idempotency_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`content_idea_id`) REFERENCES `content_ideas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_jobs_idempotency_key_unique` ON `production_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `production_jobs_status_idx` ON `production_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `production_jobs_channel_idx` ON `production_jobs` (`channel_id`);--> statement-breakpoint
CREATE TABLE `publishing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`production_job_id` text NOT NULL,
	`render_job_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`scheduled_at` integer,
	`youtube_video_id` text,
	`idempotency_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`production_job_id`) REFERENCES `production_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`render_job_id`) REFERENCES `render_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publishing_jobs_idempotency_key_unique` ON `publishing_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_status_idx` ON `publishing_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`production_job_id` text NOT NULL,
	`output_asset_id` text,
	`format` text NOT NULL,
	`settings` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`production_job_id`) REFERENCES `production_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`output_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `render_jobs_status_idx` ON `render_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `render_jobs_job_idx` ON `render_jobs` (`production_job_id`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`production_job_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`word_count` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`production_job_id`) REFERENCES `production_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_job_version_uq` ON `scripts` (`production_job_id`,`version`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`title` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `voiceovers` (
	`id` text PRIMARY KEY NOT NULL,
	`production_job_id` text NOT NULL,
	`script_id` text NOT NULL,
	`media_asset_id` text,
	`engine` text NOT NULL,
	`voice` text,
	`duration_ms` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`checkpoint` text,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`production_job_id`) REFERENCES `production_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `voiceovers_job_idx` ON `voiceovers` (`production_job_id`);