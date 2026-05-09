CREATE TABLE `pair_invite` (
	`id` text PRIMARY KEY,
	`room_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`capabilities` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_pair_invite_room_id_pair_room_id_fk` FOREIGN KEY (`room_id`) REFERENCES `pair_room`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pair_peer` (
	`id` text PRIMARY KEY,
	`room_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`capabilities` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_pair_peer_room_id_pair_room_id_fk` FOREIGN KEY (`room_id`) REFERENCES `pair_room`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pair_room` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`host_peer_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`driver_peer_id` text NOT NULL,
	`capabilities` text NOT NULL,
	`closed_at` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_pair_room_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `pair_invite_room_id_idx` ON `pair_invite` (`room_id`);--> statement-breakpoint
CREATE INDEX `pair_invite_token_hash_idx` ON `pair_invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `pair_peer_room_id_idx` ON `pair_peer` (`room_id`);--> statement-breakpoint
CREATE INDEX `pair_peer_status_idx` ON `pair_peer` (`room_id`,`status`);--> statement-breakpoint
CREATE INDEX `pair_room_session_id_idx` ON `pair_room` (`session_id`);--> statement-breakpoint
CREATE INDEX `pair_room_status_idx` ON `pair_room` (`status`);