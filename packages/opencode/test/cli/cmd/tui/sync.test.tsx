/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"
import type { Message, PairJoinResponse, PairRoomCreateResponse, Part, Session } from "@opencode-ai/sdk/v2"

const syncedSession: Session = {
  id: "ses_pair",
  slug: "pair-session",
  projectID: "proj_test",
  directory,
  title: "Pair Session",
  version: "test",
  time: { created: 1, updated: 2 },
}

const syncedMessage: Message = {
  id: "msg_pair",
  sessionID: syncedSession.id,
  role: "user",
  time: { created: 3 },
  agent: "build",
  model: { providerID: "test", modelID: "model" },
}

const syncedPart: Part = {
  id: "part_pair",
  sessionID: syncedSession.id,
  messageID: syncedMessage.id,
  type: "text",
  text: "hello pair",
}

function pairRoom(): PairRoomCreateResponse {
  return {
    id: "room_pair",
    sessionID: "ses_pair",
    hostPeerID: "peer_host",
    status: "active",
    driverPeerID: "peer_host",
    capabilities: ["view_session", "view_files", "send_prompt", "request_control"],
    closedAt: "",
    time: { created: 1, updated: 1 },
  }
}

function pairPeer(): PairJoinResponse["peer"] {
  return {
    id: "peer_guest",
    roomID: "room_pair",
    name: "Guest",
    role: "guest",
    status: "connected",
    capabilities: ["view_session", "view_files", "send_prompt", "request_control"],
    lastSeenAt: "2026-05-09T00:00:00.000Z",
    time: { created: 1, updated: 1 },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("syncs joined pair session history", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messageRequests = [] as URL[]
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${syncedSession.id}/message`) messageRequests.push(url)
      if (url.pathname === `/session/${syncedSession.id}`) return json(syncedSession)
      if (url.pathname === `/session/${syncedSession.id}/message`) return json([{ info: syncedMessage, parts: [syncedPart] }])
      if (url.pathname === `/session/${syncedSession.id}/todo`) return json([])
      if (url.pathname === `/session/${syncedSession.id}/diff`) return json([])
    })

    try {
      await sync.pair.set({ sessionID: "ses_pair", room: pairRoom(), selfPeer: pairPeer() })

      expect(messageRequests).toHaveLength(1)
      expect(sync.data.message.ses_pair.map((message) => message.id)).toEqual(["msg_pair"])
      expect(sync.data.part.msg_pair.map((part) => part.id)).toEqual(["part_pair"])
      expect(sync.pair.get("ses_pair")?.selfPeerID).toBe("peer_guest")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
