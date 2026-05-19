/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { rootDirectoryLabel } from "../../../../src/cli/cmd/tui/routes/session/footer"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("formats footer label from primary root and root count", () => {
    expect(
      rootDirectoryLabel({
        fallback: "/tmp/other:main",
        session: {
          id: "ses_roots",
          slug: "ses_roots",
          title: "Roots",
          time: { created: 1, updated: 1, processing: 0 },
          version: "1.0.0",
          directory: "/tmp/repo-a",
          projectID: "proj_a",
          cost: 0,
        },
        roots: [
          {
            id: "root_extra",
            sessionID: "ses_roots",
            directory: "/tmp/repo-b",
            worktree: "/tmp/repo-b",
            projectID: "proj_b",
            created: 2,
            primary: false,
          },
          {
            id: "root_primary",
            sessionID: "ses_roots",
            directory: "/tmp/repo-a",
            worktree: "/tmp/repo-a",
            projectID: "proj_a",
            created: 1,
            primary: true,
          },
        ],
      }),
    ).toBe("/tmp/repo-a +1 roots")
  })

  test("refreshes session roots into sync state", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_roots"
    const roots = [
      {
        id: "root_primary",
        sessionID,
        directory: "/tmp/repo-a",
        worktree: "/tmp/repo-a",
        projectID: "proj_a",
        created: 1,
        primary: true,
      },
      {
        id: "root_extra",
        sessionID,
        name: "api",
        directory: "/tmp/repo-b",
        worktree: "/tmp/repo-b",
        projectID: "proj_b",
        created: 2,
        primary: false,
      },
    ]
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        return json({
          id: sessionID,
          title: "Roots",
          time: { created: 1, updated: 1 },
          version: "1.0.0",
          directory: "/tmp/repo-a",
          project_id: "proj_a",
          cost: 0,
        })
      }
      if (url.pathname === `/session/${sessionID}/root`) return json(roots)
    })

    try {
      await expect(sync.session.refreshRoots(sessionID)).resolves.toEqual(roots)
      expect(sync.data.session_root[sessionID]).toEqual(roots)
      expect(sync.session.get(sessionID)?.directory).toBe("/tmp/repo-a")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

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

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
