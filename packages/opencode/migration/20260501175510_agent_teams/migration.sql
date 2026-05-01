CREATE TABLE `team_member` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`agent_type` text NOT NULL,
	`model` text,
	`role_prompt` text NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`plan_mode` integer DEFAULT false NOT NULL,
	`work_mode` text DEFAULT 'implement' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_message` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipients` text NOT NULL,
	`body` text NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`goal` text NOT NULL,
	`lead_session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_task` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`assignee` text,
	`dependency_ids` text,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_member_team_idx` ON `team_member` (`team_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_member_session_idx` ON `team_member` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_message_team_idx` ON `team_message` (`team_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_message_recipient_idx` ON `team_message` (`team_id`,`delivery_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_lead_session_idx` ON `team` (`lead_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_task_team_idx` ON `team_task` (`team_id`,`id`);