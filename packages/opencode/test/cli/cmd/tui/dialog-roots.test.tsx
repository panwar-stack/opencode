/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { createExit, ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { DialogRoots } from "../../../../src/cli/cmd/tui/routes/session/dialog-roots"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createEventSource, directory, json, wait } from "./sync-fixture"

const sessionID = "ses_dialog_roots"
const session = {
  id: sessionID,
  title: "Roots",
  time: { created: 1, updated: 1 },
  version: "1.0.0",
  directory: "/tmp/repo-a",
  project_id: "proj_a",
  cost: 0,
}
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

const fetchRoots = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))

  switch (url.pathname) {
    case "/agent":
    case "/command":
    case "/experimental/workspace":
    case "/experimental/workspace/status":
    case "/formatter":
    case "/lsp":
      return json([])
    case "/config":
    case "/experimental/resource":
    case "/mcp":
    case "/provider/auth":
    case "/session/status":
      return json({})
    case "/config/providers":
      return json({ providers: {}, default: {} })
    case "/experimental/console":
      return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    case "/path":
      return json({ home: "", state: "", config: "", worktree: "/tmp/repo-a", directory })
    case "/project/current":
      return json({ id: "proj_a" })
    case "/provider":
      return json({ all: [], default: {}, connected: [] })
    case "/session":
      return json([session])
    case `/session/${sessionID}`:
      return json(session)
    case `/session/${sessionID}/root`:
      return json(roots)
    case `/session/${sessionID}/message`:
    case `/session/${sessionID}/todo`:
    case `/session/${sessionID}/diff`:
      return json([])
    case "/vcs":
      return json({ branch: "main" })
  }

  throw new Error(`unexpected request: ${url.pathname}`)
}) as typeof globalThis.fetch

test("dialog roots renders with its own path formatter provider", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(ready)
    return <DialogRoots sessionID={sessionID} />
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider exit={createExit(async () => {})}>
            <KVProvider>
              <TuiConfigProvider config={config}>
                <SDKProvider url="http://test" directory={directory} fetch={fetchRoots} events={events.source}>
                  <ProjectProvider>
                    <SyncProvider>
                      <ThemeProvider mode="dark">
                        <ToastProvider>
                          <DialogProvider>
                            <box width={100} height={20}>
                              <Probe />
                            </box>
                          </DialogProvider>
                        </ToastProvider>
                      </ThemeProvider>
                    </SyncProvider>
                  </ProjectProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => <Harness />,
    { width: 100, height: 20 },
  )

  try {
    await mounted
    await wait(() => sync.status === "complete")
    await sync.session.sync(sessionID)
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("Session Roots")
    expect(frame).toContain("repo-a")
    expect(frame).toContain("api")
    expect(frame).toContain("/tmp/repo-b")
  } finally {
    app.renderer.destroy()
    Global.Path.state = previous
  }
})
