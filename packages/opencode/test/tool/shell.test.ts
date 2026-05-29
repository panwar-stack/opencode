import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import type * as Scope from "effect/Scope"
import fs from "fs/promises"
import os from "os"
import path from "path"
import vm from "node:vm"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  Session.defaultLayer,
  RuntimeFlags.defaultLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")
const encoder = new TextEncoder()

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

type RecordedCommand = {
  command: string
  args: readonly string[]
  options: ChildProcess.CommandOptions | undefined
}

type SandboxAllowlistSpec = {
  image: string
  command: string
  cwd: string
  env: Record<string, string>
  mounts: Array<{ source: string; target: string; writable: boolean }>
  hosts: string[]
  proxyPort: number
  proxyScript: string
}

function mockShellSpawner(
  records: RecordedCommand[],
  options?: {
    dockerAvailable?: boolean
    dockerRun?: { code: number; stdout?: string; stderr?: string }
  },
) {
  const output = options?.dockerRun ?? { code: 0, stdout: "sandbox output\n", stderr: "" }
  const handle = (result: { code: number; stdout?: string; stderr?: string }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(0),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as never,
      stdout: result.stdout ? Stream.make(encoder.encode(result.stdout)) : Stream.empty,
      stderr: result.stderr ? Stream.make(encoder.encode(result.stderr)) : Stream.empty,
      all:
        result.stdout || result.stderr
          ? Stream.make(encoder.encode(`${result.stdout ?? ""}${result.stderr ?? ""}`))
          : Stream.empty,
      getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as never,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      return ChildProcessSpawner.make((command) => {
        const std = ChildProcess.isStandardCommand(command) ? command : undefined
        records.push({ command: std?.command ?? "", args: std?.args ?? [], options: std?.options })
        if (std?.command === "docker" && std.args[0] === "--version") {
          return Effect.succeed(handle({ code: options?.dockerAvailable === false ? 1 : 0, stdout: "Docker version\n" }))
        }
        if (std?.command === "docker" && std.args[0] === "run") return Effect.succeed(handle(output))
        if (std?.command === process.execPath && std.args[0] === "--eval") return Effect.succeed(handle(output))
        return Effect.succeed(handle({ code: 0, stdout: "host\n" }))
      })
    }),
  )
}

function allowlistSpec(record: RecordedCommand) {
  expect(record.command).toBe(process.execPath)
  expect(record.args[0]).toBe("--eval")
  return JSON.parse(String(record.args[2])) as SandboxAllowlistSpec
}

async function proxyRequest(script: string, input: { url: string; lookup: Record<string, string[]> }) {
  const result: { status?: number; body: string; upstream?: { host: string; headers?: Record<string, string> } } = {
    body: "",
  }
  const server: { request?: (req: unknown, res: unknown) => Promise<void> | void } = {}
  const context = vm.createContext({
    process: { env: { OPENCODE_ALLOWLIST_JSON: JSON.stringify(["registry.npmjs.org"]), OPENCODE_PROXY_PORT: "3128" } },
    require: (name: string) => {
      if (name === "dns") {
        return {
          promises: {
            lookup: (host: string) =>
              Promise.resolve((input.lookup[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
          },
        }
      }
      if (name === "http") {
        return {
          createServer: (handler: (req: unknown, res: unknown) => Promise<void> | void) => {
            server.request = handler
            return { on: () => undefined, listen: () => undefined }
          },
          request: (options: { host: string; headers?: Record<string, string> }, handler: (res: unknown) => void) => {
            result.upstream = { host: options.host, headers: options.headers }
            handler({ statusCode: 200, headers: {}, pipe: (res: { end: (text: string) => void }) => res.end("ok") })
            return { on: () => undefined, write: () => undefined, end: () => undefined }
          },
        }
      }
      if (name === "net") {
        return { isIP: (value: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(value) ? 4 : value.includes(":") ? 6 : 0) }
      }
      throw new Error(`unexpected require ${name}`)
    },
    URL,
    String,
    Number,
    Error,
    Set,
  })
  vm.runInContext(script, context)
  if (!server.request) throw new Error("proxy request handler was not registered")
  await server.request(
    { url: input.url, method: "GET", headers: {}, pipe: (target: { end: () => void }) => target.end() },
    {
      writeHead: (status: number) => {
        result.status = status
      },
      end: (text: string) => {
        result.body += text
      },
    },
  )
  return result
}

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  it.live("runs with workdir inside a registered secondary root", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped()
      const secondary = yield* tmpdirScoped()
      const requests: Array<{ permission: string }> = []
      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      const result = yield* runIn(
        primary,
        run(
          {
            command: `${bin} -e "console.log(process.cwd())"`,
            workdir: secondary,
            description: "print cwd",
          },
          {
            ...ctx,
            sessionID: info.id,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
              }),
          },
        ),
      )

      expect(result.output.trim()).toBe(secondary)
      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
    }),
  )

  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
          description: "Echo test message",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell sandbox", () => {
  it.live("keeps host execution when sandbox is missing or disabled", () =>
    Effect.gen(function* () {
      const missingRecords: RecordedCommand[] = []
      const disabledRecords: RecordedCommand[] = []
      const missing = yield* tmpdirScoped()
      const disabled = yield* tmpdirScoped({ config: { sandbox: { enabled: false } } })

      const missingResult = yield* runIn(
        missing,
        run({ command: "echo host", description: "Host echo" }).pipe(Effect.provide(mockShellSpawner(missingRecords))),
      )
      const disabledResult = yield* runIn(
        disabled,
        run({ command: "echo host", description: "Host echo" }).pipe(Effect.provide(mockShellSpawner(disabledRecords))),
      )

      expect(missingResult.output).toContain("host")
      expect(disabledResult.output).toContain("host")
      expect(missingRecords.some((record) => record.command === "docker")).toBe(false)
      expect(disabledRecords.some((record) => record.command === "docker")).toBe(false)
    }),
  )

  it.live("builds docker run for enabled network-none sandbox", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: {
          sandbox: {
            enabled: true,
            profiles: {
              workspace: {
                filesystem: {
                  write: ["workspace", "temporaryDirectory"],
                  protected: ["systemRuntime"],
                },
                network: { mode: "none" },
              },
            },
          },
        },
      })

      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const prev = process.env.OPENCODE_DOCKER_TEST
          process.env.OPENCODE_DOCKER_TEST = "forwarded"
          return prev
        }),
        () =>
          runIn(
            tmp,
            run({ command: "echo sandbox", description: "Sandbox echo" }).pipe(Effect.provide(mockShellSpawner(records))),
          ),
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env.OPENCODE_DOCKER_TEST
            else process.env.OPENCODE_DOCKER_TEST = prev
          }),
      )

      const dockerRun = records.find((record) => record.command === "docker" && record.args[0] === "run")
      expect(result.output).toContain("sandbox output")
      expect(records.find((record) => record.command === "docker" && record.args[0] === "--version")).toBeDefined()
      expect(dockerRun).toBeDefined()
      expect(dockerRun!.args).toContain("--rm")
      expect(dockerRun!.args).toContain("--network")
      expect(dockerRun!.args).toContain("none")
      expect(dockerRun!.args).toContain("--workdir")
      expect(dockerRun!.args).toContain(tmp)
      expect(dockerRun!.args).toContain("--env")
      expect(dockerRun!.args).toContain("OPENCODE_DOCKER_TEST")
      expect(dockerRun!.args).toContain("ghcr.io/anomalyco/build/bun-node:24.04")
      expect(dockerRun!.args.slice(-3)).toEqual(["/bin/bash", "-lc", "echo sandbox"])
      expect(dockerRun!.args).toContain(`type=bind,source=${tmp},target=${tmp}`)
      expect(dockerRun!.args).toContain(`type=bind,source=${os.tmpdir()},target=${os.tmpdir()}`)
      expect(dockerRun!.args).toContain(
        `type=bind,source=${path.dirname(process.execPath)},target=${path.dirname(process.execPath)},readonly`,
      )
      expect(dockerRun!.options?.cwd).toBe(tmp)
    }),
  )

  it.live("fails with exact error when docker is unavailable", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "none" } } } } },
      })

      const error = yield* runIn(
        tmp,
        fail(
          { command: "echo sandbox", description: "Sandbox echo" },
          ctx,
        ).pipe(Effect.provide(mockShellSpawner(records, { dockerAvailable: false }))),
      )

      expect(error.message).toBe("Sandbox is enabled but Docker is unavailable")
      expect(records.find((record) => record.command === "docker" && record.args[0] === "--version")).toBeDefined()
      expect(records.find((record) => record.command === "docker" && record.args[0] === "run")).toBeUndefined()
    }),
  )

  it.live("keeps explicit workspace writable while protecting child mounts", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: {
          sandbox: {
            enabled: true,
            profiles: {
              workspace: {
                filesystem: {
                  write: ["workspace"],
                  protected: ["workspace/secrets"],
                },
                network: { mode: "none" },
              },
            },
          },
        },
      })
      const secrets = path.join(tmp, "secrets")
      yield* Effect.promise(() => fs.mkdir(secrets))

      yield* runIn(
        tmp,
        run({ command: "echo sandbox", description: "Sandbox echo" }).pipe(Effect.provide(mockShellSpawner(records))),
      )

      const dockerRun = records.find((record) => record.command === "docker" && record.args[0] === "run")
      const mounts = dockerRun?.args.filter((arg) => arg.startsWith("type=bind,")) ?? []
      expect(mounts).toContain(`type=bind,source=${tmp},target=${tmp}`)
      expect(mounts).toContain(`type=bind,source=${secrets},target=${secrets},readonly`)
      expect(mounts).not.toContain(`type=bind,source=${os.tmpdir()},target=${os.tmpdir()}`)
      expect(mounts).not.toContain(
        `type=bind,source=${path.dirname(process.execPath)},target=${path.dirname(process.execPath)},readonly`,
      )
    }),
  )

  it.live("builds internal network and proxy for allowlist sandbox", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: {
          sandbox: {
            enabled: true,
            profiles: { workspace: { network: { mode: "allowlist", hosts: ["registry.npmjs.org"] } } },
          },
        },
      })

      const result = yield* runIn(
        tmp,
        run({ command: "echo sandbox", description: "Sandbox echo" }).pipe(Effect.provide(mockShellSpawner(records))),
      )

      const orchestrator = records.find((record) => record.command === process.execPath && record.args[0] === "--eval")
      expect(result.output).toContain("sandbox output")
      expect(records.find((record) => record.command === "docker" && record.args[0] === "--version")).toBeDefined()
      expect(orchestrator).toBeDefined()
      const script = String(orchestrator!.args[1])
      const spec = allowlistSpec(orchestrator!)
      expect(spec.hosts).toEqual(["registry.npmjs.org"])
      expect(spec.proxyScript).toContain("direct IP egress is blocked")
      expect(spec.proxyScript).toContain("host resolves to a private or reserved address")
      expect(script).toContain('"network", "create", "--internal", network')
      expect(script).toContain('"run",\n    "-d"')
      expect(script).toContain('"--network",\n    "bridge"')
      expect(script).toContain('"network", "connect", "--alias", "proxy", network, proxy')
      expect(script).toContain('"--network",\n    network')
      expect(script).toContain('"HTTP_PROXY=http://proxy:"')
      expect(script).toContain('"HTTPS_PROXY=http://proxy:"')
      expect(script).toContain('"ALL_PROXY=http://proxy:"')
      expect(script).not.toContain('"--network",\n    "bridge",\n    "--workdir"')
    }),
  )

  it.live("allowlist proxy allows registry.npmjs.org", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "allowlist", hosts: ["registry.npmjs.org"] } } } } },
      })

      yield* runIn(
        tmp,
        run({ command: "npm view bun", description: "Sandbox registry" }).pipe(Effect.provide(mockShellSpawner(records))),
      )

      const orchestrator = records.find((record) => record.command === process.execPath && record.args[0] === "--eval")
      if (!orchestrator) throw new Error("missing allowlist orchestrator")
      const result = yield* Effect.promise(() =>
        proxyRequest(allowlistSpec(orchestrator).proxyScript, {
          url: "http://registry.npmjs.org/bun",
          lookup: { "registry.npmjs.org": ["104.16.0.35"] },
        }),
      )

      expect(result.status).not.toBe(403)
      expect(result.upstream?.host).toBe("104.16.0.35")
      expect(result.upstream?.headers?.host).toBe("registry.npmjs.org")
    }),
  )

  it.live("allowlist proxy blocks unlisted hosts and redirect follow-up requests", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "allowlist", hosts: ["registry.npmjs.org"] } } } } },
      })

      yield* runIn(
        tmp,
        run({ command: "curl -L http://registry.npmjs.org/pkg", description: "Sandbox redirect" }).pipe(
          Effect.provide(mockShellSpawner(records)),
        ),
      )

      const orchestrator = records.find((record) => record.command === process.execPath && record.args[0] === "--eval")
      if (!orchestrator) throw new Error("missing allowlist orchestrator")
      const unlisted = yield* Effect.promise(() =>
        proxyRequest(allowlistSpec(orchestrator).proxyScript, {
          url: "http://example.com/",
          lookup: { "example.com": ["93.184.216.34"] },
        }),
      )
      const redirected = yield* Effect.promise(() =>
        proxyRequest(allowlistSpec(orchestrator).proxyScript, {
          url: "http://evil.example/second-hop",
          lookup: { "evil.example": ["93.184.216.34"] },
        }),
      )

      expect(unlisted.status).toBe(403)
      expect(unlisted.body).toContain("host is not allowlisted")
      expect(redirected.status).toBe(403)
      expect(redirected.body).toContain("host is not allowlisted")
    }),
  )

  it.live("allowlist proxy blocks direct IP egress", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "allowlist", hosts: ["registry.npmjs.org"] } } } } },
      })

      yield* runIn(
        tmp,
        run({ command: "curl http://104.16.0.35/", description: "Sandbox direct IP" }).pipe(
          Effect.provide(mockShellSpawner(records)),
        ),
      )

      const orchestrator = records.find((record) => record.command === process.execPath && record.args[0] === "--eval")
      if (!orchestrator) throw new Error("missing allowlist orchestrator")
      const result = yield* Effect.promise(() =>
        proxyRequest(allowlistSpec(orchestrator).proxyScript, { url: "http://104.16.0.35/", lookup: {} }),
      )

      expect(result.status).toBe(403)
      expect(result.body).toContain("direct IP egress is blocked")
    }),
  )

  it.live("allowlist proxy rejects private or reserved resolved IPs", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "allowlist", hosts: ["registry.npmjs.org"] } } } } },
      })

      yield* runIn(
        tmp,
        run({ command: "curl http://registry.npmjs.org/", description: "Sandbox private resolved IP" }).pipe(
          Effect.provide(mockShellSpawner(records)),
        ),
      )

      const orchestrator = records.find((record) => record.command === process.execPath && record.args[0] === "--eval")
      if (!orchestrator) throw new Error("missing allowlist orchestrator")
      const result = yield* Effect.promise(() =>
        proxyRequest(allowlistSpec(orchestrator).proxyScript, {
          url: "http://registry.npmjs.org/",
          lookup: { "registry.npmjs.org": ["127.0.0.1"] },
        }),
      )

      expect(result.status).toBe(403)
      expect(result.body).toContain("host resolves to a private or reserved address")
    }),
  )

  it.live("requires full network approval before checking docker", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "full" } } } } },
      })

      yield* runIn(
        tmp,
        run(
          { command: "echo sandbox", description: "Sandbox echo" },
          {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                expect(records.length).toBe(0)
                requests.push(request)
              }),
          },
        ).pipe(Effect.provide(mockShellSpawner(records))),
      )

      expect(requests.map((request) => request.permission)).toEqual(["bash", "sandbox_network"])
      expect(requests[1]).toMatchObject({
        permission: "sandbox_network",
        patterns: ["sandbox_network:full:workspace"],
        always: ["sandbox_network:full:workspace"],
        metadata: { profile: "workspace", mode: "full", command: "echo sandbox" },
      })
      expect(records[0]).toMatchObject({ command: "docker", args: ["--version"] })
    }),
  )

  it.live("full network rejection prevents docker", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const stop = new Error("network rejected")
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "full" } } } } },
      })

      const error = yield* runIn(
        tmp,
        fail(
          { command: "echo sandbox", description: "Sandbox echo" },
          {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
                if (request.permission === "sandbox_network") throw stop
              }),
          },
        ).pipe(Effect.provide(mockShellSpawner(records))),
      )

      expect(error.message).toBe(stop.message)
      expect(requests.map((request) => request.permission)).toEqual(["bash", "sandbox_network"])
      expect(records.find((record) => record.command === "docker")).toBeUndefined()
    }),
  )

  it.live("skips full network approval when explicitly disabled and uses docker default network", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const tmp = yield* tmpdirScoped({
        config: {
          sandbox: {
            enabled: true,
            profiles: { workspace: { network: { mode: "full", requiresApproval: false } } },
          },
        },
      })

      yield* runIn(
        tmp,
        run({ command: "echo sandbox", description: "Sandbox echo" }, capture(requests)).pipe(
          Effect.provide(mockShellSpawner(records)),
        ),
      )

      const dockerRun = records.find((record) => record.command === "docker" && record.args[0] === "run")
      expect(requests.find((request) => request.permission === "sandbox_network")).toBeUndefined()
      expect(dockerRun).toBeDefined()
      expect(dockerRun!.args).not.toContain("--network")
      expect(dockerRun!.args).not.toContain("none")
    }),
  )

  it.live("default full network requires approval", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "full" } } } } },
      })

      yield* runIn(
        tmp,
        run({ command: "echo sandbox", description: "Sandbox echo" }, capture(requests)).pipe(
          Effect.provide(mockShellSpawner(records)),
        ),
      )

      expect(requests.find((request) => request.permission === "sandbox_network")).toBeDefined()
    }),
  )

  it.live("asks permissions before checking docker", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "none" } } } } },
      })

      yield* runIn(
        tmp,
        run(
          { command: "echo sandbox", description: "Sandbox echo" },
          {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                expect(records.length).toBe(0)
                requests.push(request)
              }),
          },
        ).pipe(Effect.provide(mockShellSpawner(records))),
      )

      expect(requests.find((request) => request.permission === "bash")).toBeDefined()
      expect(records[0]).toMatchObject({ command: "docker", args: ["--version"] })
    }),
  )

  it.live("preserves docker stderr and non-zero exit through run", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "none" } } } } },
      })

      const result = yield* runIn(
        tmp,
        run({ command: "exit 7", description: "Sandbox failure" }).pipe(
          Effect.provide(mockShellSpawner(records, { dockerRun: { code: 7, stdout: "out\n", stderr: "err\n" } })),
        ),
      )

      expect(result.metadata.exit).toBe(7)
      expect(result.output).toContain("out")
      expect(result.output).toContain("err")
    }),
  )

  it.live("prompts for external workdir before sandbox docker commands", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const tmp = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "none" } } } } },
      })
      const outer = yield* tmpdirScoped()

      yield* runIn(
        tmp,
        run(
          { command: "echo external", workdir: outer, description: "External sandbox workdir" },
          {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                expect(records.length).toBe(0)
                requests.push(request)
              }),
          },
        ).pipe(Effect.provide(mockShellSpawner(records))),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeDefined()
      expect(records[0]).toMatchObject({ command: "docker", args: ["--version"] })
    }),
  )

  it.live("does not prompt for secondary root workdir under sandbox", () =>
    Effect.gen(function* () {
      const records: RecordedCommand[] = []
      const primary = yield* tmpdirScoped({
        config: { sandbox: { enabled: true, profiles: { workspace: { network: { mode: "none" } } } } },
      })
      const secondary = yield* tmpdirScoped()
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "sandbox roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      yield* runIn(
        primary,
        run(
          { command: "echo secondary", workdir: secondary, description: "Secondary root sandbox" },
          {
            ...ctx,
            sessionID: info.id,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
              }),
          },
        ).pipe(Effect.provide(mockShellSpawner(records))),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
      expect(records.find((record) => record.command === "docker" && record.args[0] === "run")).toBeDefined()
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
              description: "Read wildcard path",
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                    description: "Copy Windows ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                  description: "Read nested PowerShell file",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                    description: "Read home config",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                    description: "Read pshome file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "OPENCODE_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read Windows ini from FileSystem provider",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                    description: "Read Windows ini from braced env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                  description: "Change location",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                description: "Read Windows ini with cmd",
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                    description: "Echo from Git Bash tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                    description: "Read Git Bash tmp file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la", description: "List" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo started && sleep 60`,
            description: "Timeout test",
            timeout: 500,
          })
          expect(result.output).toContain("started")
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("commands will time out after 500ms")
          const result = yield* tool.execute(
            {
              command: `echo started && sleep 60`,
              description: "Default timeout test",
            },
            ctx,
          )
          expect(result.output).toContain("started")
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
            description: "Stderr test",
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
          description: "Non-zero exit",
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
            description: "Streaming test",
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
          description: "Generate one line",
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* AppFileSystem.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})
