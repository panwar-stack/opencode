CREATE TABLE `memory_citation` (
	`id` text PRIMARY KEY,
	`constraint_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_citation_constraint_id_memory_constraint_id_fk` FOREIGN KEY (`constraint_id`) REFERENCES `memory_constraint`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_constraint_source` (
	`constraint_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `memory_constraint_source_pk` PRIMARY KEY(`constraint_id`, `source_item_id`),
	CONSTRAINT `fk_memory_constraint_source_constraint_id_memory_constraint_id_fk` FOREIGN KEY (`constraint_id`) REFERENCES `memory_constraint`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_memory_constraint_source_source_item_id_memory_source_item_id_fk` FOREIGN KEY (`source_item_id`) REFERENCES `memory_source_item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_constraint` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`files` text NOT NULL,
	`directories` text NOT NULL,
	`symbols` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_constraint_repository_id_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_repository` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_source_item` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`provider` text NOT NULL,
	`source_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`pr_number` integer,
	`author` text,
	`url` text NOT NULL,
	`path` text,
	`line` integer,
	`position` integer,
	`title` text,
	`labels` text,
	`source_created_at` integer,
	`source_updated_at` integer,
	`source_cursor` text,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_source_item_repository_id_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_sync_checkpoint` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`cursor` text,
	`last_fetched_at` integer,
	`fetch_options` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_sync_checkpoint_repository_id_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_citation_constraint_url_idx` ON `memory_citation` (`constraint_id`,`url`);--> statement-breakpoint
CREATE INDEX `memory_citation_constraint_idx` ON `memory_citation` (`constraint_id`);--> statement-breakpoint
CREATE INDEX `memory_constraint_source_item_idx` ON `memory_constraint_source` (`source_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_constraint_repository_text_idx` ON `memory_constraint` (`repository_id`,`text`);--> statement-breakpoint
CREATE INDEX `memory_constraint_repository_status_idx` ON `memory_constraint` (`repository_id`,`status`);--> statement-breakpoint
CREATE INDEX `memory_constraint_repository_time_updated_idx` ON `memory_constraint` (`repository_id`,`time_updated`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_repository_provider_repo_idx` ON `memory_repository` (`provider`,`repo`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_source_item_repository_provider_source_idx` ON `memory_source_item` (`repository_id`,`provider`,`source_id`);--> statement-breakpoint
CREATE INDEX `memory_source_item_repository_path_idx` ON `memory_source_item` (`repository_id`,`path`);--> statement-breakpoint
CREATE INDEX `memory_source_item_repository_pr_idx` ON `memory_source_item` (`repository_id`,`pr_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_sync_checkpoint_provider_repo_idx` ON `memory_sync_checkpoint` (`provider`,`repo`);
