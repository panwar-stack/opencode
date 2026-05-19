/** @jsxImportSource @opentui/solid */
import { describe, expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Global } from "@opencode-ai/core/global"
import { onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { RouteProvider } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { LocalProvider } from "../../../../src/cli/cmd/tui/context/local"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { createEventSource, directory, json, wait, worktree } from "./sync-fixture"

mock.module("../../../../src/cli/cmd/tui/keymap", () => ({
  useBindings: () => {},
  useCommandShortcut: (command: string) => () => (command === "command.palette.show" ? "ctrl+p" : "tab"),
  useLeaderActive: () => () => false,
  useOpencodeKeymap: () => ({
    pending: () => [],
  }),
}))

mock.module("../../../../src/cli/cmd/tui/component/prompt/autocomplete", () => ({
  Autocomplete: () => <box />,
}))

mock.module("../../../../src/cli/cmd/tui/context/command-palette", () => ({
  CommandPaletteProvider: (props: { children: unknown }) => props.children,
  useCommandPalette: () => ({
    hide: () => {},
    matcher: { get: () => true },
    run: () => {},
    show: () => {},
    toggle: () => {},
    visible: () => false,
  }),
}))

const sessionID = "ses_prompt_footer"
const created = Date.now() - 62_000

const sessionPayload = {
  id: sessionID,
  title: "Prompt footer",
  time: { created, updated: created, processing: 62_000 },
  version: "1.0.0",
  directory,
  project_id: "proj_test",
  cost: 0.05,
}

const messagesPayload = [
  {
    info: {
      id: "msg_assistant",
      role: "assistant",
      sessionID,
      providerID: "test",
      modelID: "model",
      mode: "build",
      path: { cwd: directory, root: worktree },
      cost: 0.05,
      tokens: {
        input: 1_000,
        output: 200,
        reasoning: 30,
        cache: { read: 400, write: 5 },
      },
      time: { created, completed: created + 1_000 },
    },
    parts: [],
  },
]

const fetchForPrompt = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))

  switch (url.pathname) {
    case "/agent":
      return json([{ name: "build", mode: "primary", hidden: false }])
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
      return json({
        providers: [
          {
            id: "test",
            name: "Test",
            models: {
              model: {
                id: "model",
                name: "Model",
                limit: { context: 10_000 },
              },
            },
          },
        ],
        default: { test: "model" },
      })
    case "/experimental/console":
      return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    case "/path":
      return json({ home: "", state: "", config: "", worktree, directory })
    case "/project/current":
      return json({ id: "proj_test" })
    case "/provider":
      return json({ all: [], default: {}, connected: [] })
    case "/session":
      return json([sessionPayload])
    case `/session/${sessionID}`:
      return json(sessionPayload)
    case `/session/${sessionID}/root`:
      return json([])
    case `/session/${sessionID}/message`:
      return json(messagesPayload)
    case `/session/${sessionID}/todo`:
    case `/session/${sessionID}/diff`:
      return json([])
    case "/vcs":
      return json({ branch: "main" })
  }

  throw new Error(`unexpected request: ${url.pathname}`)
}) as typeof globalThis.fetch

async function mountPrompt(props: { sessionID?: string }) {
  const { Prompt } = await import("../../../../src/cli/cmd/tui/component/prompt")
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(ready)
    return <Prompt sessionID={props.sessionID} />
  }

  const app = await testRender(
    () => (
      <ArgsProvider>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider
                initialRoute={props.sessionID ? { type: "session", sessionID: props.sessionID } : undefined}
              >
                <TuiConfigProvider
                  config={{
                    attention: {
                      enabled: false,
                      notifications: true,
                      sound: true,
                      volume: 0.4,
                      sound_pack: "",
                      sounds: {},
                    },
                    keybinds: createBindingLookup({}),
                    leader_timeout: 2_000,
                  }}
                >
                  <SDKProvider url="http://test" directory={directory} fetch={fetchForPrompt} events={events.source}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <PromptHistoryProvider>
                                  <EditorContextProvider>
                                    <box width={100} height={8}>
                                      <Probe />
                                    </box>
                                  </EditorContextProvider>
                                </PromptHistoryProvider>
                              </DialogProvider>
                            </PromptStashProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    ),
    { width: 100, height: 8 },
  )

  await mounted
  await wait(() => sync.status === "complete")
  return { app, sync }
}

describe("prompt footer", () => {
  test("renders elapsed time before usage and commands when session is synced", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mountPrompt({ sessionID })

    try {
      await sync.session.sync(sessionID)
      expect(sync.data.message[sessionID]?.at(-1)).toMatchObject({
        role: "assistant",
        tokens: { output: 200 },
      })
      await app.renderOnce()
      const frame = app.captureCharFrame()

      expect(frame).toContain("1m")
      expect(frame).toContain("1.6K (16%) · $0.05")
      expect(frame).toContain("ctrl+p commands")
      expect(frame.indexOf("1m")).toBeLessThan(frame.indexOf("1.6K (16%) · $0.05"))
      expect(frame.indexOf("1.6K (16%) · $0.05")).toBeLessThan(frame.indexOf("ctrl+p commands"))
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("hides elapsed time when session data is unavailable", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app } = await mountPrompt({ sessionID: "missing" })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()

      expect(frame).not.toContain("1m")
      expect(frame).toContain("tab agents")
      expect(frame).toContain("ctrl+p commands")
      expect(frame.indexOf("tab agents")).toBeLessThan(frame.indexOf("ctrl+p commands"))
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
