CREATE TABLE `session_root` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`name` text,
	`directory` text NOT NULL,
	`worktree` text NOT NULL,
	`project_id` text NOT NULL,
	`path` text,
	`created` integer NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_session_root_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_root_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `session_root` (`id`, `session_id`, `name`, `directory`, `worktree`, `project_id`, `path`, `created`, `primary`)
SELECT 'sesroot_' || `session`.`id`, `session`.`id`, NULL, `session`.`directory`, COALESCE(`project`.`worktree`, `session`.`directory`), `session`.`project_id`, `session`.`path`, `session`.`time_created`, 1
FROM `session`
LEFT JOIN `project` ON `project`.`id` = `session`.`project_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_root_session_directory_idx` ON `session_root` (`session_id`,`directory`);--> statement-breakpoint
CREATE INDEX `session_root_session_idx` ON `session_root` (`session_id`);
