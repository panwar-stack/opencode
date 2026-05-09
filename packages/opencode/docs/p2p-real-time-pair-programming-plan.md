# Real-Time Peer-to-Peer Pair Programming and Remote Session Sync Plan

## Summary

Add peer-to-peer real-time pair programming and remote TUI session sync by reusing opencode's existing sync and event architecture instead of creating a separate collaboration stack. The recommended MVP is a single-driver model with explicit handoff because the current `SyncEvent` model is sequence-based and not designed for true concurrent multi-writer editing.

## Current State

TUI pair join already hydrates session history when the guest is connected to the same host opencode server. The remaining gap is remote coworker onboarding: `/pair-invite` still needs to carry enough connection intent for a coworker on another machine to find and attach to the host, including private LAN, VPN, firewall, NAT, SSH-tunnel, relay, and reverse-tunnel setups.

## Goal

Allow a remote opencode user to join another user's pair room and receive real-time session sync with scoped pair authorization, without sharing server credentials.

## Recommended Scope

Build the feature in phases:

1. Passive presence and pairing room.
2. Shared session viewing, remote onboarding, and cursor/activity indicators.
3. Shared composer draft and typing state.
4. Explicit driver control handoff.
5. WebRTC data channel transport with WebSocket relay fallback.
6. Optional advanced capabilities: remote shell, terminal sharing, permission approval delegation.

## Connectivity and Onboarding

Remote pair invites must carry enough connection intent for guests to attach to non-public hosts through an explicit access path instead of assuming the host server URL is globally reachable.

- Treat private, loopback, and otherwise non-public host addresses as supported deployment shapes, not warnings-only edge cases.
- Allow invites to describe the required transport/access method, such as direct URL, VPN/private network URL, SSH tunnel target, reverse tunnel, relay, or user-provided attach command.
- Keep pair authorization separate from transport authorization: the invite may explain how to reach the host, but scoped pair credentials still come only from the host join flow.
- Surface connectivity setup as part of `/pair-invite`, `/pair-join`, and `/pair-status` so both host and guest can see whether the host is reachable, waiting for a tunnel, or connected through a relay/private route.
- Keep token-only join as a local/same-server fallback, and let `/pair-join` accept either a raw token or a full invite link.

## Architecture Direction

Use existing foundations:

- `Bus` and `/event`/`/global/event` for live local UI updates.
- `SyncEvent` history/replay for durable session/message state.
- Existing workspace sync pattern: `/sync/history`, `/sync/replay`, remote SSE, `GlobalBus`.
- PTY ticket/WebSocket pattern for scoped realtime socket auth.
- Team subsystem patterns for rooms/members/status, but do not reuse it directly for human P2P.

Key files:

- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/bus/bus-event.ts`
- `packages/opencode/src/bus/global.ts`
- `packages/opencode/src/sync/index.ts`
- `packages/opencode/src/sync/event.sql.ts`
- `packages/opencode/src/server/routes/instance/sync.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`
- `packages/opencode/src/pty/ticket.ts`
- `packages/opencode/src/server/routes/instance/pty.ts`
- `packages/opencode/src/team/team.ts`

## Backend Phase 1: Pair Domain

Add a new pair module:

- `packages/opencode/src/pair/pair.ts`
- `packages/opencode/src/pair/pair.sql.ts`
- `packages/opencode/src/pair/ticket.ts`

Core tables:

- `pair_room`
- `pair_peer`
- `pair_invite`

Suggested `pair_room` fields:

- `id`
- `session_id`
- `workspace_id`
- `instance_id`
- `host_peer_id`
- `status`
- `driver_peer_id`
- `capabilities`
- `created_at`
- `updated_at`
- `closed_at`

Suggested `pair_peer` fields:

- `id`
- `room_id`
- `name`
- `role`: `host | guest`
- `status`: `invited | connected | disconnected | left`
- `capabilities`
- `last_seen_at`
- `created_at`

Suggested `pair_invite` fields:

- `id`
- `room_id`
- `token_hash`
- `connection_profile`
- `capabilities`
- `expires_at`
- `consumed_at`
- `created_at`

Core service methods:

- `Pair.Service.createRoom(sessionID, options)`
- `Pair.Service.issueInvite(roomID, capabilities, ttl, connectionProfile)`
- `Pair.Service.join(inviteToken, peerInfo)`
- `Pair.Service.leave(roomID, peerID)`
- `Pair.Service.closeRoom(roomID)`
- `Pair.Service.requestControl(roomID, peerID)`
- `Pair.Service.grantControl(roomID, peerID)`
- `Pair.Service.revokeControl(roomID, peerID)`
- `Pair.Service.authorize(roomID, peerID, capability)`

Use `InstanceState` if active room socket/session state needs project-scoped cleanup.

## Backend Phase 2: Scoped Auth

Do not share server Basic Auth or `auth_token` with peers.

Model pair auth after PTY tickets:

- `packages/opencode/src/pty/ticket.ts`
- `packages/opencode/src/server/shared/pty-ticket.ts`

Add `PairTicket` scoped to:

- `roomID`
- `sessionID`
- `peerID`
- `directory`
- `workspaceID`
- capabilities
- expiry
- one-time signaling use where appropriate

Capabilities should be explicit:

- `view_session`
- `view_files`
- `send_prompt`
- `request_control`
- `control_driver`
- `edit_files`
- `run_shell`
- `approve_permissions`
- `share_terminal`

Default guest capabilities for MVP:

- `view_session`
- `view_files`
- `send_prompt` only through host-approved driver flow
- `request_control`

Avoid remote permission approvals in the MVP.

## Backend Phase 3: Events

Add pair-specific `BusEvent` definitions.

Durable events should be persisted as sync events only when they affect room/session state:

- `pair.room.created`
- `pair.room.closed`
- `pair.peer.joined`
- `pair.peer.left`
- `pair.control.requested`
- `pair.control.granted`
- `pair.control.revoked`
- `pair.remote.submitted`

Ephemeral events should stay Bus-only:

- `pair.presence.updated`
- `pair.cursor.updated`
- `pair.selection.updated`
- `pair.prompt.updated`
- `pair.typing.updated`
- `pair.connection.updated`

Important: throttle/coalesce high-volume events like cursor and draft updates.

## Backend Phase 4: Routes

Add route parity for legacy Hono and Effect HttpApi.

New files:

- `packages/opencode/src/server/routes/instance/pair.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/pair.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/pair.ts`

Register in:

- `packages/opencode/src/server/routes/instance/index.ts`
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`

Suggested endpoints:

- `POST /pair/rooms`
- `GET /pair/rooms/:roomID`
- `GET /pair/rooms/:roomID/status`
- `DELETE /pair/rooms/:roomID`
- `POST /pair/rooms/:roomID/invite`
- `POST /pair/join` accepts either a raw token or a full invite link and resolves the connection profile before exchanging scoped credentials.
- `POST /pair/rooms/:roomID/leave`
- `POST /pair/rooms/:roomID/control/request`
- `POST /pair/rooms/:roomID/control/grant`
- `POST /pair/rooms/:roomID/control/revoke`
- `GET /pair/rooms/:roomID/signaling-token`
- `GET /pair/rooms/:roomID/signaling`

If WebRTC is implemented, `/signaling` should be WebSocket signaling only. If relay fallback is needed, the same route can carry pair event envelopes directly.

## Backend Phase 5: Sync Integration

Reuse `SyncEvent`.

Initial join flow:

1. Host creates pair room for a session.
2. Host issues invite with scoped capabilities and a connection profile.
3. Guest resolves the invite link or raw token into a reachable host endpoint, then joins with the invite token.
4. Guest receives room state and peer ticket.
5. Guest catches up using session sync history.
6. Live events flow over P2P data channel or relay.
7. Durable host-side mutations are applied through `SyncEvent.run`.
8. Remote-applied durable mutations use `SyncEvent.replay`.

MVP rule:

- Only current driver can create durable session/message mutations.
- Guests can send draft/control/prompt intent events.
- Host applies accepted mutations locally.
- Host's normal `Bus` and `SyncEvent` flow keeps local clients updated.

Avoid true concurrent writers until there is a clear conflict strategy.

## Transport Phase

Use a layered transport:

1. Signaling: server WebSocket using pair ticket.
2. Primary data path: WebRTC data channel.
3. Fallback: server WebSocket relay.
4. Future: TURN configuration for stricter NAT environments.

Why this direction:

- WebRTC gives actual peer-to-peer data transfer.
- Existing server can broker signaling safely.
- WebSocket relay gives predictable behavior when P2P fails.
- The existing HTTP/SSE workspace sync pattern can be reused for catch-up and fallback semantics.

Add configuration for:

- STUN servers
- optional TURN servers
- relay allowed/disabled
- max peers per room
- invite TTL
- event throttle intervals

## Client SDK

Add pair APIs to the generated SDK.

Files:

- `packages/sdk/js/src/v2/client.ts`
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`

After adding server API schemas, regenerate SDK with:

```sh
./packages/sdk/js/script/build.ts
```

Expose APIs like:

- `client.pair.createRoom`
- `client.pair.getRoom`
- `client.pair.getStatus`
- `client.pair.invite`
- `client.pair.join`
- `client.pair.leave`
- `client.pair.requestControl`
- `client.pair.grantControl`
- `client.pair.revokeControl`

Also update event type unions for `pair.*`.

## Web/Desktop UI

Integrate through the existing global event and sync contexts.

Important files:

- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/context/sdk.tsx`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/context/notification.tsx`
- `packages/app/src/pages/layout.tsx`

Web UI changes:

- Add pair room state to global sync store.
- Add reducer cases for pair events.
- Add session header pair pill with participant count and connection state.
- Add "Start Pair Session" and "Copy Invite Link".
- Add invite copy/share that can emit a full join link, private-network link, tunnel instructions, relay link, or attach command depending on reachability.
- Add join flow from invite/deep link or raw token.
- Add pair status surface with host URL, access method, room ID, peer ID, driver, and connection state.
- Add composer lock/driver indicator.
- Add "Request Control", "Grant Control", "Revoke Control".
- Add remote typing indicator.
- Add draft preview or shared draft display.
- Add notification/toast for invite, peer join/leave, control request, control granted.
- Add actionable errors for unreachable hosts, missing tunnel/VPN setup, relay failures, and expired/consumed invites.

Special handling:

- `pages/session.tsx` auto-focus behavior must not steal input while view-only or remote-controlled.
- `prompt-input/submit.ts` must check driver/capability state before submitting.
- Optimistic message insertion must only happen for the local driver's accepted submission.

## TUI UI

Mirror the same core functionality in TUI.

Important files:

- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx`
- `packages/opencode/src/cli/cmd/tui/context/event.ts`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-status.tsx`

TUI changes:

- Add pair invite command that copies a full join link, private-network link, tunnel setup instructions, relay link, or attach command depending on host reachability.
- Add pair join command that accepts either full invite links or raw tokens.
- Add pair status command/dialog showing host URL, access method, room ID, peer ID, driver, and connection state.
- Parse invite links in `/pair-join`.
- Resolve the invite connection profile into a reachable host endpoint, then create a temporary SDK client pointed at that endpoint.
- Store remote pair connection state keyed by room/session.
- Navigate to the joined session after bootstrap succeeds.
- Add pair events to sync reducer.
- Add pair participant/control state.
- Add session commands:
  - start pair
  - copy invite
  - leave pair
  - request control
  - grant control
  - revoke control
- Add footer indicator for pair connection and driver.
- Disable prompt input when local peer is not driver.
- Show toast/dialog for control requests, peer join/leave, and connectivity errors.
- Add pair status section to status dialog.

## Desktop

Account for desktop sidecar behavior.

Files:

- `packages/desktop/src/main/server.ts`
- `packages/desktop/src/renderer/index.tsx`
- `packages/desktop/src/main/ipc.ts`

Desktop-specific plan:

- Pair invite links should open the desktop renderer.
- Use renderer notifications for clickable join/control events.
- Do not assume the local sidecar is publicly reachable.
- Use P2P/relay transport rather than exposing desktop server auth.

## Conflict Model

MVP should explicitly avoid true multi-writer behavior.

Rules:

- One active driver per room.
- Host starts as driver.
- Guests can request control.
- Host can grant/revoke control.
- Only driver can submit prompts or commands.
- Dangerous actions still require host-local permission approval unless explicitly delegated later.
- Cursor/draft/presence are ephemeral and last-write-wins.
- Durable session/message state remains `SyncEvent` backed.

This keeps the design compatible with existing `event_sequence` assumptions.

## Security Requirements

Required before shipping:

- Invites are scoped, expiring, and revocable.
- Pair tickets are not server credentials.
- Transport authorization stays separate from pair authorization.
- Capabilities are enforced server-side.
- Guest cannot call arbitrary instance APIs.
- Guest cannot approve host-local filesystem/shell permissions by default.
- Invite links should not expose Basic Auth or full server URL credentials.
- Host UI must clearly show when session/file/prompt context is shared.
- Add audit attribution for remote submissions.

## Testing Plan

Backend tests:

- room create/join/leave/close
- invite expiry and single-use behavior
- invite generation includes host routing metadata and connection profile
- non-public host invite generation records an explicit connection profile
- private/VPN host URLs resolve before join
- tunnel/attach-command joins wait for the forwarded endpoint before consuming the invite
- raw token join still works on the same server
- capability enforcement
- driver handoff
- unauthorized peer rejection
- sync catch-up from history
- replay accepted remote mutation
- reject non-driver mutation
- WebSocket ticket expiry/consume behavior

Client tests:

- reducer handles pair events
- composer disables for non-driver
- control request/grant UI state
- notification behavior for pair events
- no notification spam for cursor/draft events

Integration tests:

- host and guest join same room
- guest catches up existing session history
- remote join creates a scoped remote pair client
- remote join bootstraps session messages and parts
- host submits prompt and guest sees update
- guest requests control
- host grants control
- guest submits prompt through driver path
- live host events update guest TUI state
- non-driver prompt submission is blocked
- pair status surfaces host URL, access method, and connection state
- disconnected peer status updates
- relay fallback path works

Run verification from package directories, especially:

- `packages/opencode`: `bun typecheck`
- `packages/app`: app-specific typecheck/test commands if available
- SDK regeneration after API changes

## Implementation Order

1. Add pair database schema and service.
2. Add pair ticket/invite model and connection profile.
3. Add pair Bus events.
4. Add pair routes in Hono and Effect HttpApi.
5. Add SDK generation support.
6. Add WebSocket signaling route.
7. Add WebRTC data channel client transport with relay fallback.
8. Add web app pair state, invite/deep-link join, and session header UI.
9. Add web composer locking/control handoff.
10. Add TUI pair state, invite parsing, status dialog, footer indicator, and prompt lock.
11. Add notifications, connectivity errors, and desktop deep-link behavior.
12. Add tests and typecheck.
13. Harden security, throttling, cleanup, and stale-room handling.
