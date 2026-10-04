CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`indexed_text` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_idea_id` ON `attachments` (`idea_id`);--> statement-breakpoint
CREATE TABLE `canvas` (
	`id` integer PRIMARY KEY NOT NULL,
	`pan_x` real NOT NULL,
	`pan_y` real NOT NULL,
	`zoom` real NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "canvas_singleton" CHECK("canvas"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "connections_canonical_pair" CHECK("connections"."from_id" < "connections"."to_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connections_pair` ON `connections` (`from_id`,`to_id`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`source_label` text NOT NULL,
	`source_url` text NOT NULL,
	`source_at` text NOT NULL,
	`tags_json` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`archived` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ideas_archived" CHECK("ideas"."archived" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ideas_id_unique` ON `ideas` (`id`);--> statement-breakpoint
CREATE TABLE `mutation_guard` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`result` text NOT NULL
);
