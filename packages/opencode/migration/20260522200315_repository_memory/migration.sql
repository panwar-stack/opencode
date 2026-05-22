CREATE TABLE `repository_memory_commit` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`hash` text NOT NULL,
	`message` text NOT NULL,
	`author_time` integer NOT NULL,
	`branch` text,
	`base_commit` text,
	`changed_files` text NOT NULL,
	`diff` text NOT NULL,
	`issue_number` integer,
	`issue_title` text,
	`issue_body` text,
	`token_text` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_repository_memory_commit_repository_id_repository_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository_memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repository_memory_file_activity` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`edit_count` integer NOT NULL,
	`last_modified` integer,
	`co_changed_files` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_repository_memory_file_activity_repository_id_repository_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository_memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repository_memory_file_summary` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`source_hash` text NOT NULL,
	`summary` text NOT NULL,
	`important_symbols` text NOT NULL,
	`token_text` text NOT NULL,
	`model_id` text,
	`time_generated` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_repository_memory_file_summary_repository_id_repository_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository_memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repository_memory_repository` (
	`id` text PRIMARY KEY,
	`identity` text NOT NULL UNIQUE,
	`provider` text,
	`owner` text,
	`name` text,
	`default_branch` text,
	`base_commit` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repository_memory_retrieval_log` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`session_id` text,
	`issue_identifier` text,
	`tool` text NOT NULL,
	`query` text NOT NULL,
	`returned_items` text NOT NULL,
	`selected_items` text,
	`final_files` text,
	`outcome` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_repository_memory_retrieval_log_repository_id_repository_memory_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository_memory_repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `repository_memory_commit_repository_id_hash_idx` ON `repository_memory_commit` (`repository_id`,`hash`);--> statement-breakpoint
CREATE INDEX `repository_memory_commit_repository_id_author_time_idx` ON `repository_memory_commit` (`repository_id`,`author_time`);--> statement-breakpoint
CREATE INDEX `repository_memory_file_activity_repository_id_path_idx` ON `repository_memory_file_activity` (`repository_id`,`path`);--> statement-breakpoint
CREATE INDEX `repository_memory_file_summary_repository_id_path_idx` ON `repository_memory_file_summary` (`repository_id`,`path`);--> statement-breakpoint
CREATE INDEX `repository_memory_retrieval_log_repository_id_session_id_idx` ON `repository_memory_retrieval_log` (`repository_id`,`session_id`);