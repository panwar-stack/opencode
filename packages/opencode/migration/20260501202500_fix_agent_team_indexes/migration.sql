DROP INDEX IF EXISTS `team_message_recipient_idx`;
--> statement-breakpoint
CREATE INDEX `team_message_recipient_idx` ON `team_message` (`team_id`,`delivery_status`);
