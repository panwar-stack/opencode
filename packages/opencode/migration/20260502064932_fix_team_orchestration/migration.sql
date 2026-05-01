CREATE TABLE `team_message_recipient` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`team_id` text NOT NULL,
	`recipient` text NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `team_message_recipient` (`id`, `message_id`, `team_id`, `recipient`, `delivery_status`, `time_created`, `time_updated`)
SELECT `team_message`.`id` || ':' || `json_each`.`key`, `team_message`.`id`, `team_message`.`team_id`, `json_each`.`value`, `team_message`.`delivery_status`, `team_message`.`time_created`, `team_message`.`time_updated`
FROM `team_message`, json_each(`team_message`.`recipients`);
--> statement-breakpoint
ALTER TABLE `team_member` ADD `dependency_ids` text;--> statement-breakpoint
ALTER TABLE `team_member` ADD `result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `team_message_recipient_message_idx` ON `team_message_recipient` (`message_id`,`recipient`);--> statement-breakpoint
CREATE INDEX `team_message_recipient_status_idx` ON `team_message_recipient` (`team_id`,`recipient`,`delivery_status`);
