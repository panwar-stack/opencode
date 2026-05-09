# Remote TUI Pair Session Sync Plan

## Current State

TUI pair join now hydrates session history when the guest is already connected to the same host opencode server. The remaining gap is remote coworker onboarding: `/pair-invite` copies only an opaque invite token, so a coworker on another machine does not know which host server to connect to.

## Goal

Allow a remote opencode TUI user to join another user's pair room and receive real-time session sync with scoped pair authorization, without sharing server credentials. This must work when the host opencode server is not directly public, including private LAN, VPN, firewall, NAT, and SSH-tunnel setups.

## First-Class Connectivity Requirement

Remote pair invites must carry enough connection intent for guests to attach to non-public hosts through an explicit access path instead of assuming the host server URL is globally reachable.

- Treat private, loopback, and otherwise non-public host addresses as supported deployment shapes, not warnings-only edge cases.
- Allow invites to describe the required transport/access method, such as direct URL, VPN/private network URL, SSH tunnel target, reverse tunnel, relay, or user-provided attach command.
- Keep pair authorization separate from transport authorization: the invite may explain how to reach the host, but scoped pair credentials still come only from the host join flow.
- Surface connectivity setup as part of `/pair-invite`, `/pair-join`, and `/pair-status` so both host and guest can see whether the host is reachable, waiting for a tunnel, or connected through a relay/private route.

## Plan

1. Add full invite links
   - Include host connection profile, room ID, invite token, session ID, expiry, and workspace or instance routing metadata.
   - Connection profile includes direct host URL plus optional private-route metadata such as VPN host, tunnel command hints, relay ID, reverse tunnel endpoint, or manual attach command.
   - Keep token-only join as a local/same-server fallback.
   - Detect `localhost`, private IPs, and other non-public addresses and require the invite flow to choose or confirm an access path instead of producing an unusable public-link-shaped invite.

2. Add non-public host connection flows
   - Support direct private network/VPN joins when the guest can reach the host URL from their machine.
   - Support SSH tunnel or attach-command based joins where `/pair-invite` provides a command template and `/pair-join` waits until the local forwarded URL is reachable.
   - Leave room for relay/reverse-tunnel support when neither peer can accept inbound connections.
   - Validate host reachability before consuming an invite token where possible, and provide retryable setup errors when the access path is not ready.

3. Add scoped remote pair auth
   - Guest calls host `POST /pair/join` with the invite token.
   - Host returns room, peer, and scoped pair credentials/tickets.
   - Pair credentials must only authorize pair/session-view/sync endpoints, not arbitrary instance APIs.

4. Add remote pair client state in TUI
   - Parse invite links in `/pair-join`.
   - Resolve the invite connection profile into a reachable host endpoint, then create a temporary SDK client pointed at that endpoint.
   - Store remote pair connection state keyed by room/session.
   - Navigate to the joined session after bootstrap succeeds.

5. Bootstrap host session history on join
   - Fetch session metadata, messages, parts, todos, and status for `room.sessionID` from the host.
   - Reuse existing sync/session hydration paths where possible.
   - Render the session only after the initial history is loaded.

6. Subscribe to live host events
   - Open a scoped pair signaling WebSocket or scoped SSE subscription after bootstrap.
   - Reduce host session and pair events through the existing TUI sync store.
   - Track connection state and mark stale/disconnected peers clearly.

7. Preserve single-driver mutation rules
   - Host starts as driver.
   - Guest can request control.
   - Host/current driver can grant or revoke control.
   - Non-driver prompt input remains locked.
   - Guest driver submissions must go through host pair endpoints, not general instance APIs.

8. Improve TUI UX
   - `/pair-invite` copies a full join link, private-network link, tunnel setup instructions, relay link, or attach command depending on host reachability.
   - `/pair-join` accepts either full links or raw tokens.
   - Add `/pair-status` showing host URL, access method, room ID, peer ID, driver, and connection state.
   - Show actionable errors for unreachable hosts, missing tunnel/VPN setup, relay setup failures, and expired/consumed invites.

9. Add tests
   - Invite link generation includes host routing metadata.
   - Non-public host invite generation records an explicit connection profile.
   - `/pair-join` resolves direct private/VPN host URLs before joining.
   - Tunnel/attach-command joins wait for the forwarded endpoint before consuming the invite.
   - Raw token join still works on same server.
   - Remote join creates a scoped remote pair client.
   - Remote join bootstraps session messages and parts.
   - Live host events update guest TUI state.
   - Non-driver prompt submission is blocked.
   - Driver handoff allows guest prompt submission through pair flow.
   - Pair credentials cannot call arbitrary instance APIs.

## Known Limitation Until Implemented

Remote coworkers must manually connect their TUI to the host opencode server before using `/pair-join`; the current invite token alone is not enough to discover or attach to the host, especially when the host is only reachable through a private network, VPN, SSH tunnel, or future relay path.
