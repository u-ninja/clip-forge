CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`run_after` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`error` text,
	`result` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`run_after`,`priority`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`status`,`lease_expires_at`);