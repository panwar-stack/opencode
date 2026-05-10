import { expect, spyOn, test } from "bun:test"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { INTERNAL_TUI_PLUGINS } from "../../../src/cli/cmd/tui/plugin/internal"

const { TuiPluginRuntime } = await import("../../../src/cli/cmd/tui/plugin/runtime")
const { TuiConfig } = await import("../../../src/cli/cmd/tui/config/tui")

test("team sidebar plugin is registered as internal", () => {
  const teamPlugin = INTERNAL_TUI_PLUGINS.find((p) => p.id === "internal:sidebar-team")
  expect(teamPlugin).toBeDefined()
  expect(teamPlugin?.id).toBe("internal:sidebar-team")
  expect(teamPlugin?.tui).toBeTypeOf("function")
})

test("team sidebar plugin loads and is active", async () => {
  const cwd = spyOn(process, "cwd").mockImplementation(() => "/tmp")
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()

  const api = createTuiPluginApi()
  const config = createTuiResolvedConfig({
    plugin: [] as string[],
    plugin_origins: [],
    plugin_enabled: {},
  })

  try {
    await TuiPluginRuntime.init({ api, config })
    const plugins = TuiPluginRuntime.list()
    const teamPlugin = plugins.find((p) => p.id === "internal:sidebar-team")
    expect(teamPlugin).toBeDefined()
    expect(teamPlugin?.active).toBe(true)
    expect(teamPlugin?.source).toBe("internal")
    expect(teamPlugin?.enabled).toBe(true)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
  }
})

test("plugin_enabled false prevents team plugin from activating", async () => {
  const cwd = spyOn(process, "cwd").mockImplementation(() => "/tmp")
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()

  const api = createTuiPluginApi()
  const config = createTuiResolvedConfig({
    plugin: [] as string[],
    plugin_origins: [],
    plugin_enabled: {
      "internal:sidebar-team": false,
    },
  })

  try {
    await TuiPluginRuntime.init({ api, config })
    const plugins = TuiPluginRuntime.list()
    const teamPlugin = plugins.find((p) => p.id === "internal:sidebar-team")
    expect(teamPlugin).toBeDefined()
    expect(teamPlugin?.active).toBe(false)
    expect(teamPlugin?.enabled).toBe(false)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
  }
})

test("team plugin toggles off and on", async () => {
  const cwd = spyOn(process, "cwd").mockImplementation(() => "/tmp")
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()

  const api = createTuiPluginApi()
  const config = createTuiResolvedConfig({
    plugin: [] as string[],
    plugin_origins: [],
    plugin_enabled: {},
  })

  try {
    await TuiPluginRuntime.init({ api, config })

    // Initially active
    let plugins = TuiPluginRuntime.list()
    let teamPlugin = plugins.find((p) => p.id === "internal:sidebar-team")
    expect(teamPlugin?.active).toBe(true)

    // Deactivate
    await TuiPluginRuntime.deactivatePlugin("internal:sidebar-team")
    plugins = TuiPluginRuntime.list()
    teamPlugin = plugins.find((p) => p.id === "internal:sidebar-team")
    expect(teamPlugin?.active).toBe(false)
    expect(teamPlugin?.enabled).toBe(false)

    // Reactivate
    await TuiPluginRuntime.activatePlugin("internal:sidebar-team")
    plugins = TuiPluginRuntime.list()
    teamPlugin = plugins.find((p) => p.id === "internal:sidebar-team")
    expect(teamPlugin?.active).toBe(true)
    expect(teamPlugin?.enabled).toBe(true)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
  }
})
