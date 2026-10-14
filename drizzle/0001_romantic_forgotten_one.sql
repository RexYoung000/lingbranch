ALTER TABLE `connections` ADD `relation_type` text DEFAULT 'related' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `ideas` ADD `body_format` text DEFAULT 'plain' NOT NULL;