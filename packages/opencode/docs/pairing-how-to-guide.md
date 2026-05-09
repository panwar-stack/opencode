# opencode Pair Programming Guide

Pair programming in opencode lets two users share a session in real time.
One person drives (controls the prompt), the other watches and can request
control. Both see the same session messages, diffs, and tool outputs as they
happen.

## Quick Start

```
Host:                     Guest:
  /pair-start               (receives invite link)
  /pair-invite               /pair-join
  (send link to guest)
```

## Examples

### Example 1: Two terminals on the same machine

This is the fastest path. The host and guest both connect to the same local
opencode server, so the guest can use either a raw invite token or the full
invite URI.

Host:

```text
/pair-start
/pair-invite
```

Guest:

```text
/pair-join
paste: 2v6A5f1qV0P4d4...  (raw token)
```

What happens:

- The guest joins the same server the host is already using.
- No VPN, tunnel, or tailnet setup is needed.
- The guest lands in the host's session and can request control.

### Example 2: Two people on the same LAN or VPN

Use this when the host server is reachable on a private IP address such as
`192.168.1.5:4096`.

Host:

```text
/pair-start
/pair-invite
```

Invite URI:

```text
opencode://pair-join?hostUrl=http%3A%2F%2F192.168.1.5%3A4096&roomID=room-abc&token=tok-123&sessionID=ses-456&expiresAt=2026-12-31T23%3A59%3A59.000Z&connectionProfile=%7B%22method%22%3A%22private_network%22%2C%22hostUrl%22%3A%22http%3A%2F%2F192.168.1.5%3A4096%22%7D
```

Guest:

```text
/pair-join
paste the invite URI
```

What happens:

- The guest must be on the same private network or VPN.
- `pair-status` shows `Access: private_network`.
- If the host is unreachable, the guest sees the private-network error
  message and can check routing or firewall settings.

### Example 3: Tailscale or Headscale tailnet

Use this when both machines are connected to the same tailnet and the host is
reachable via MagicDNS or a tailnet IP.

Host:

```text
/pair-start
/pair-invite
```

Setup:

```text
tailscale status
```

If you run Headscale, connect the client to your control server first:

```text
tailscale up --login-server https://headscale.example.com
```

Invite URI:

```text
opencode://pair-join?hostUrl=http%3A%2F%2Fmonitoring.yak-bebop.ts.net%3A4096&roomID=room-tailnet&token=tok-789&sessionID=ses-999&expiresAt=2026-12-31T23%3A59%3A59.000Z&connectionProfile=%7B%22method%22%3A%22tailnet%22%2C%22hostUrl%22%3A%22http%3A%2F%2Fmonitoring.yak-bebop.ts.net%3A4096%22%7D
```

Guest:

```text
/pair-join
paste the invite URI
```

What happens:

- Both machines stay on the tailnet instead of exposing the host publicly.
- The guest can use a `*.ts.net` MagicDNS hostname or a `100.x` tailnet IP.
- `pair-status` shows `Access: tailnet`.
- If you want a stable hostname, enable MagicDNS for the tailnet.

### Example 4: Host behind NAT with an SSH tunnel

Use this when the host cannot be reached directly, but you can forward the
host port through SSH.

Guest:

```bash
ssh -L 4096:localhost:4096 user@host-machine
```

Host:

```text
/pair-start
/pair-invite
```

Guest:

```text
/pair-join
paste the invite URI
```

What happens:

- The local `localhost:4096` on the guest forwards traffic to the host.
- The guest keeps using the invite URI, but the tunnel makes the host
  reachable.
- `pair-status` shows `Access: ssh_tunnel` when the invite describes that
  transport.

### Example 5: Control handoff during a session

Once the guest has joined, control can move back and forth without leaving
the room.

Host:

```text
/pair-status
/pair-grant
```

Guest:

```text
/pair-request
```

What happens:

- The guest requests control.
- The host sees the request and grants it.
- The guest becomes the driver and can submit prompts.
- The host can later run `/pair-revoke` to take control back.

## Commands

| Command          | Who                  | What it does                              |
| ---------------- | -------------------- | ----------------------------------------- |
| `/pair-start`    | Host                 | Start a pair session on the current tab   |
| `/pair-invite`   | Host                 | Copy an invite link to clipboard          |
| `/pair-join`     | Guest                | Join using an invite link or raw token    |
| `/pair-status`   | Anyone in the room   | Show room ID, peers, driver, connection   |
| `/pair-request`  | Guest                | Ask the host to hand over control         |
| `/pair-grant`    | Host / current driver| Give control to a requesting guest        |
| `/pair-revoke`   | Host / current driver| Take control back from a guest            |
| `/pair-leave`    | Anyone in the room   | Leave the pair session                    |

## Host: Starting a Pair Session

1. Open a session in opencode TUI.
2. Type `/pair-start` and press Enter.

   This creates a pair room linked to your current session. You become the
   host and initial driver.

3. Your status bar will show `◈ Pair 1 driver`.

## Host: Inviting a Guest

1. Type `/pair-invite`. The invite link is copied to your clipboard.

2. Share the link with your guest (Slack, email, etc.). The link looks like:

   ```
   opencode://pair-join?hostUrl=http%3A%2F%2F192.168.1.5%3A4096&roomID=...
   &token=...&sessionID=...&expiresAt=...&connectionProfile=...
   ```

   The link includes:
   - Your server URL
   - The room ID and invite token
   - Session routing metadata
   - Connection profile (how the guest should reach you)

   opencode automatically tags the connection profile as one of:
   - `direct` for public URLs
   - `tailnet` for Tailscale / Headscale paths
   - `private_network` for RFC1918 private addresses
   - `ssh_tunnel`, `relay`, or `manual` when the host needs an explicit attach path

3. Invites expire after **15 minutes** and are **single-use**. Generate a new
   invite for each guest.

### What the Host Sees About Reachability

After copying the invite, opencode detects how reachable your server is:

| Host address       | Detection              | Toast message                                             |
| ------------------ | ---------------------- | --------------------------------------------------------- |
| Public IP / domain | `direct`               | No extra toast; link works as-is                          |
| Tailnet host       | `tailnet`              | "Share the MagicDNS name or 100.x tailnet address"       |
| Private IP         | `private_network`      | "Guest must be on same VPN/network"                       |
| localhost          | `manual`               | "Share connection instructions manually"                  |
| Any non-public     | depends on IP range    | Host is notified if the guest needs special setup         |

## Guest: Joining a Pair Session

### Same Server (e.g. two terminals on the same machine)

1. Type `/pair-join`.
2. Paste the **raw token** or the full invite link.
3. Press Enter.

The guest TUI loads the host's session history and navigates to it
automatically.

### Remote (different machines)

The guest must be able to reach the host's opencode server. The connection
method depends on the host's network:

#### Direct (public host)

The host's server is on a public IP or reachable domain. Just paste the
invite link and press Enter.

#### Private Network / VPN

The host's server is on a private IP (10.x, 192.168.x, 172.16-31.x).

1. The guest must be on the same private network or VPN as the host.
2. Paste the invite link and press Enter.
3. If the host is unreachable, opencode shows:
   `Could not reach http://192.168.1.5:4096. Ensure you are on the same VPN/private network.`

#### Tailscale / Headscale Tailnet

The host is reachable over a tailnet address or MagicDNS name.

1. Make sure both machines are connected to the same tailnet.
2. Paste the invite link and press Enter.
3. If the host is unreachable, opencode shows:
   `Could not reach http://monitoring.yak-bebop.ts.net:4096. Make sure Tailscale or Headscale is connected and the MagicDNS name or tailnet IP resolves.`

Setup notes:

- Install the Tailscale client on both machines.
- Sign both machines into the same tailnet.
- Make sure the host's opencode server listens on a non-loopback interface, such as `0.0.0.0` or the machine's reachable tailnet/LAN address. If the server only listens on `localhost`, the guest cannot reach it over tailnet.
- If you want to use a human-friendly hostname instead of the tailnet IP, enable MagicDNS for the tailnet and give the host a stable machine name.
- If you use Headscale, point the Tailscale client at your Headscale control server with `tailscale up --login-server <YOUR_HEADSCALE_URL>` and complete registration.
- On the guest machine, `tailscale status` should show the host as online before you join.

Tailnet hosts can use either:

- A `*.ts.net` MagicDNS hostname
- A `100.64.0.0/10` tailnet IP
- A custom Headscale-backed DNS name that resolves over the tailnet

#### SSH Tunnel

The host is behind NAT or a firewall and not reachable directly. The guest
needs to set up an SSH tunnel to forward the host's port:

1. Run the tunnel command on the guest machine:

   ```bash
   ssh -L 4096:localhost:4096 user@host-machine
   ```

   This forwards `localhost:4096` on the guest to port 4096 on the host.

2. Paste the invite link. The URL in the link points to the host's real
   address — since the guest now has a tunnel forwarding that address, the
   connection works transparently.

#### Local / Same Machine

Two TUI instances on the same machine. Both connect to the same server
(localhost). Paste the raw token and join — no networking setup needed.

### Invite Link vs Raw Token

| Input format                    | Behavior                                  |
| ------------------------------- | ----------------------------------------- |
| `opencode://pair-join?...` URI  | Auto-detects remote vs local, parses host |
| Raw token string                | Same-server fallback                      |

You can always paste a raw token. If you paste an invite link, opencode
automatically handles routing to the right server.

## Driver Control

Only one peer can send prompts at a time — the **driver**. The host starts
as driver.

### Guest Requests Control

1. Guest types `/pair-request`.
2. The host sees a control request indicator.
3. `/pair-grant` becomes available in the host's command palette.

### Host Grants Control

1. Host types `/pair-grant`.
2. The guest is now the driver.
3. Guest's prompt input unlocks. Guest can send prompts.
4. Host's prompt locks (read-only, shows "Pair session is read-only until
   control is granted").

### Host Revokes Control

1. Host types `/pair-revoke`.
2. Control returns to the host.
3. Guest's prompt locks again.

### Who Can Do What

| Action              | Host   | Guest (not driver) | Guest (driver) |
| ------------------- | ------ | ------------------ | -------------- |
| View session        | ✓      | ✓                  | ✓              |
| Send prompts        | ✓      | ✗                  | ✓              |
| Request control     | —      | ✓                  | —              |
| Grant / revoke      | ✓      | ✗                  | ✗              |
| Issue invites       | ✓      | ✗                  | ✗              |
| Close room          | ✓      | ✗                  | ✗              |

## Pair Status

Type `/pair-status` to see:

```
Room ID: abc123...
Session: sess_xyz...
Status: active
Host: local  (or http://remote-host:4096 for remote)
Access: direct  (or private_network / ssh_tunnel / manual)
Connection: connected
Driver: peer-uuid-here
Peers:
  * Alice (connected) [DRIVER] (you)
    Bob (connected)
Self: peer-uuid-here
```

The footer also shows a compact status:
`◈ Pair 2 driver`  (or `◈ Pair 2 viewer` if you're not driving)

## Leaving a Pair Session

Type `/pair-leave`. This:

- Disconnects you from the room
- Cleans up your pair state
- For remote: closes the remote SDK client and SSE connection
- The other peer remains in the room

When both peers leave, the room is effectively dormant. The host can close
it or it remains available for rejoining with a new invite.

## How It Works

### Architecture

```
┌─────────────┐         ┌─────────────┐
│  Host TUI   │◄───────►│  Guest TUI  │
│  (opencode) │  HTTP   │  (opencode) │
└──────┬──────┘  + SSE  └──────┬──────┘
       │                       │
       ▼                       ▼
┌─────────────┐         ┌─────────────┐
│ Host Server │◄────────│ Guest       │
│ (4096)      │  join   │ connects    │
│  pair room  │  token  │ via SDK     │
│  session    │         │             │
│  bus events │────────►│ SSE stream  │
└─────────────┘         └─────────────┘
```

1. **Host** creates a room linked to their session with `/pair-start`.
2. **Host** issues an invite with `/pair-invite`. The invite link contains
   the server URL, room ID, token, and connection profile.
3. **Guest** pastes the link with `/pair-join`.
4. **Guest's TUI** connects to the host's server via the SDK, calls
   `POST /pair/join` with the token, and receives a room assignment + peer
   ID + scoped credential.
5. **Guest's TUI** bootstraps session history (messages, parts, todos,
   diff) from the host, then subscribes to live events via SSE.
6. **Both TUIs** see the same session state and receive real-time updates
   as pair events (`peer.joined`, `control.granted`, etc.) flow through
   the bus.

### Scoped Credentials

Remote guests receive a scoped credential (24-hour lifetime) that only
authorizes access to the specific pair room and session. The credential
cannot be used to call arbitrary instance APIs — it is rejected by the
server auth middleware for non-pair endpoints.

### Event Synchronization

The host server publishes pair events on its internal bus. The guest
subscribes via SSE to `pair.*` events filtered to the room. Both TUIs
update their sync stores from the same event stream:

- `pair.peer.joined` / `pair.peer.left` — presence updates
- `pair.control.requested` / `pair.control.granted` / `pair.control.revoked` — driver changes
- `pair.presence.updated` / `pair.connection.updated` — online/offline status

## Troubleshooting

### Guest can't connect (direct method)

```
Could not connect to http://198.51.100.5:4096. Check network/firewall settings.
```

- Verify the host's opencode server is running and listening on the
  expected interface (check `server.hostname` config).
- Check the host's firewall allows inbound connections on the server port.
- Try `curl http://host-ip:4096` from the guest machine to test
  reachability.

### Guest can't connect (private_network method)

```
Could not reach http://192.168.1.5:4096. Ensure you are on the same VPN/private network.
```

- Both machines must be on the same private network or VPN.
- Verify the private IP is correct and reachable: `ping 192.168.1.5`.

### Guest can't connect (tailnet method)

```
Could not reach http://monitoring.yak-bebop.ts.net:4096. Make sure Tailscale or Headscale is connected and the MagicDNS name or tailnet IP resolves.
```

- Confirm both machines are attached to the same tailnet.
- Try `tailscale status` on both machines and confirm the peer is online.
- If you use Headscale, confirm the client is logged into the expected control server and the hostname resolves inside the tailnet DNS.
- Verify the tailnet hostname or `100.x` address is reachable from the guest machine.

### Guest can't connect (ssh_tunnel method)

```
Could not connect. Run the tunnel command first: ssh -L 4096:localhost:4096 user@host
```

- Set up the SSH tunnel before joining.
- The tunnel command forwards a local port to the host's opencode port.
- Verify the tunnel is active: `lsof -i :4096` (macOS) or `ss -tlnp | grep 4096` (Linux).

### Invite expired

```
This invite has expired. Ask the host for a new invite.
```

Invites last 15 minutes. The host needs to run `/pair-invite` again.

### Invite already used

```
This invite has already been used.
```

Invites are single-use. The host needs to generate a new one.

### Prompt is locked

If you see "Pair session is read-only until control is granted" in the
prompt area, you are not the driver. Type `/pair-request` to ask for
control.

### Stale / disconnected peer

If a peer's status shows as disconnected, their network connection dropped.
The peer may need to rejoin. The connection retries with exponential
backoff (1s → 30s).

## Security

- **Invite tokens** are 32-byte cryptographically random values, hashed
  with SHA-256 before storage. The server never stores the raw token.
- **Scoped credentials** (for remote guests) only grant access to the pair
  room and session. They cannot call arbitrary instance APIs, edit files,
  run shell commands, or approve permissions unless explicitly granted by
  the host.
- **Server auth** (Basic auth, if `OPENCODE_SERVER_PASSWORD` is set) is
  bypassed for pair-session paths when a valid pair credential is
  presented. Pair credentials are the sole authorization for those
  endpoints.
- **Tailnet connectivity** is still transport, not authorization. A
  Tailscale or Headscale path only helps the guest reach the host server;
  the guest still needs a valid pair invite and scoped credential.
- **Single-use invites**: Each token can only be consumed once. After a
  guest joins, the invite is marked consumed.
- **Driver isolation**: Non-drivers cannot submit prompts. Only the
  host (or a host-granted driver) can mutate the session.
