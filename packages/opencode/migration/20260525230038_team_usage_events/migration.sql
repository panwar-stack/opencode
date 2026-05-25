CREATE TABLE `team_usage_event` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`session_id` text,
	`member_id` text,
	`type` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`time_created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_usage_event_team_idx` ON `team_usage_event` (`team_id`,`time_created`);