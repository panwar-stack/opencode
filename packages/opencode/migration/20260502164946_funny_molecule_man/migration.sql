DROP INDEX IF EXISTS `team_lead_session_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `team_active_lead_session_idx` ON `team` (`lead_session_id`) WHERE "team"."status" = 'active';