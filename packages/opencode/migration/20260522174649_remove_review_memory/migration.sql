DROP INDEX IF EXISTS `memory_citation_constraint_url_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_citation_constraint_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_constraint_source_item_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_constraint_repository_text_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_constraint_repository_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_constraint_repository_time_updated_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_repository_provider_repo_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_source_item_repository_provider_source_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_source_item_repository_path_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_source_item_repository_pr_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `memory_sync_checkpoint_provider_repo_idx`;--> statement-breakpoint
DROP TABLE `memory_citation`;--> statement-breakpoint
DROP TABLE `memory_constraint_source`;--> statement-breakpoint
DROP TABLE `memory_constraint`;--> statement-breakpoint
DROP TABLE `memory_repository`;--> statement-breakpoint
DROP TABLE `memory_source_item`;--> statement-breakpoint
DROP TABLE `memory_sync_checkpoint`;