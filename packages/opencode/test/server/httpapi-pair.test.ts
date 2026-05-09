import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { PairPaths } from "../../src/server/routes/instance/httpapi/groups/pair"
import { PairSessionPaths } from "../../src/server/routes/instance/httpapi/groups/pair-session"
import { Server } from "../../src/server/server"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app(experimental = true) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function path(route: string, roomID: string) {
  return route.replace(":roomID", roomID)
}

function sessionPath(route: string, roomID: string) {
  return path(route, roomID)
}

async function createRoom(input: { experimental: boolean; directory: string; sessionID: string }) {
  const response = await app(input.experimental).request(PairPaths.createRoom, {
    method: "POST",
    headers: { "x-opencode-directory": input.directory, "content-type": "application/json" },
    body: JSON.stringify({ sessionID: input.sessionID, hostName: "Host" }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: string; hostPeerID: string; driverPeerID: string }
}

function seedSession(directory: string) {
  return Database.use((db) => {
    const now = Date.now()
    const sessionID = SessionID.descending()
    db.insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: directory,
        vcs: null,
        name: "Pair Route Test",
        icon_url: null,
        icon_url_override: null,
        icon_color: null,
        time_created: now,
        time_updated: now,
        time_initialized: null,
        sandboxes: [],
        commands: null,
      })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        workspace_id: null,
        parent_id: null,
        slug: "pair-route-test",
        directory,
        path: null,
        title: "Pair Route Test",
        version: "test",
        share_url: null,
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        summary_diffs: null,
        revert: null,
        permission: null,
        agent: null,
        model: null,
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
      })
      .run()
    return sessionID
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("pair HttpApi bridge", () => {
  test("serves pair room, invite, join, and control routes through Effect routes", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    expect(invite.status).toBe(200)
    const inviteBody = (await invite.json()) as { token: string; capabilities: string[] }
    expect(inviteBody.capabilities).not.toContain("run_shell")

    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    expect(joined.status).toBe(200)
    const joinedBody = (await joined.json()) as { peer: { id: string } }

    const grant = await app().request(path(PairPaths.grantControl, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ peerID: joinedBody.peer.id, actorPeerID: room.hostPeerID }),
    })
    expect(grant.status).toBe(200)
    expect(await grant.json()).toMatchObject({ id: room.id, driverPeerID: joinedBody.peer.id })
  })

  test("requires actor authority for privileged pair routes", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })
    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const guest = (await (
      await app().request(PairPaths.join, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: ((await invite.json()) as { token: string }).token, name: "Guest" }),
      })
    ).json()) as { peer: { id: string } }

    const denied = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: guest.peer.id }),
    })
    expect(denied.status).toBe(403)
  })

  test("matches Hono pair route success shape", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const sessionID = seedSession(tmp.path)
    const legacy = await createRoom({ experimental: false, directory: tmp.path, sessionID })
    await resetDatabase()
    const httpapi = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    expect(Object.keys(httpapi).sort()).toEqual(Object.keys(legacy).sort())
    expect(httpapi).toMatchObject({ status: "active", driverPeerID: httpapi.hostPeerID })
  })

  test("rejects signaling token requests without ticket header", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })
    const response = await app().request(`${path(PairPaths.signalingToken, room.id)}?peerID=${room.hostPeerID}`, {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(403)
  })
})

describe("pair auth middleware", () => {
  test("pair-session endpoint rejects request without Bearer token", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })
    const response = await app().request(sessionPath(PairSessionPaths.info, room.id), {
      headers: { "x-opencode-directory": tmp.path },
    })
    expect(response.status).toBe(401)
  })

  test("pair-session endpoint accepts request with valid pair credential", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const sessionResp = await app().request(sessionPath(PairSessionPaths.info, room.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(sessionResp.status).toBe(200)
  })

  test("pair-session endpoint rejects request with invalid credential", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })
    const response = await app().request(sessionPath(PairSessionPaths.info, room.id), {
      headers: { "x-opencode-directory": tmp.path, authorization: "Bearer invalid-token-12345" },
    })
    expect(response.status).toBe(401)
  })

  test("pair endpoints do not require pair credential (use normal Authorization middleware)", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    // getRoom endpoint uses normal Authorization middleware, not PairAuthMiddleware
    const resp = await app().request(path(PairPaths.getRoom, room.id), {
      headers: { ...headers },
    })
    expect(resp.status).toBe(200)
    const roomInfo = (await resp.json()) as { id: string; status: string }
    expect(roomInfo.id).toBe(room.id)
    expect(roomInfo.status).toBe("active")
  })
})

describe("pair session history bootstrap", () => {
  test("GET /pair/rooms/:roomID/session returns session info", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const sessionResp = await app().request(sessionPath(PairSessionPaths.info, room.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(sessionResp.status).toBe(200)
    const sessionBody = await sessionResp.json()
    expect(sessionBody).toHaveProperty("id")
    expect(sessionBody).toHaveProperty("title")
  })

  test("GET /pair/rooms/:roomID/session/messages returns messages", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const msgResp = await app().request(sessionPath(PairSessionPaths.messages, room.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(msgResp.status).toBe(200)
    expect(Array.isArray(await msgResp.json())).toBe(true)
  })

  test("GET /pair/rooms/:roomID/session/todos returns todos", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const todoResp = await app().request(sessionPath(PairSessionPaths.todos, room.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(todoResp.status).toBe(200)
    expect(Array.isArray(await todoResp.json())).toBe(true)
  })

  test("GET /pair/rooms/:roomID/session/diff returns diff", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const room = await createRoom({ experimental: true, directory: tmp.path, sessionID: seedSession(tmp.path) })

    const invite = await app().request(path(PairPaths.issueInvite, room.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const diffResp = await app().request(sessionPath(PairSessionPaths.diff, room.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(diffResp.status).toBe(200)
    expect(Array.isArray(await diffResp.json())).toBe(true)
  })

  test("session endpoints return data for the room in the URL path", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const sessionID2 = seedSession(tmp.path)
    const room2 = await createRoom({ experimental: true, directory: tmp.path, sessionID: sessionID2 })

    const invite = await app().request(path(PairPaths.issueInvite, room2.id), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ actorPeerID: room2.hostPeerID }),
    })
    const inviteBody = (await invite.json()) as { token: string }
    const joined = await app().request(PairPaths.join, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteBody.token, name: "Guest" }),
    })
    const joinedBody = (await joined.json()) as { credential?: { token: string } }
    expect(joinedBody.credential).toBeTruthy()

    const sessionResp = await app().request(sessionPath(PairSessionPaths.info, room2.id), {
      headers: { ...headers, authorization: `Bearer ${joinedBody.credential!.token}` },
    })
    expect(sessionResp.status).toBe(200)
    const sessionBody = (await sessionResp.json()) as { id: string }
    expect(sessionBody.id).toBe(sessionID2)
  })
})
