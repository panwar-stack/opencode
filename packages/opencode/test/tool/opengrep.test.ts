import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Opengrep } from "@/file/opengrep"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { OpengrepTool } from "@/tool/opengrep"
import { Truncate } from "@/tool/truncate"
import type * as Tool from "@/tool/tool"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

type SpawnResult = {
  code: number
  stdout?: string
  stderr?: string
}

type SpawnInput = {
  command: string
  args: readonly string[]
}

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function mockSpawner(handler: (input: SpawnInput) => Effect.Effect<SpawnResult>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const std = ChildProcess.isStandardCommand(command) ? command : undefined
        const result = yield* handler({ command: std?.command ?? "", args: std?.args ?? [] })
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as never,
          stdout: result.stdout ? Stream.make(encoder.encode(result.stdout)) : Stream.empty,
          stderr: result.stderr ? Stream.make(encoder.encode(result.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    ),
  )
}

function httpLayer(response: Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response.clone()))),
  )
}

function opengrepLayer(handler: (input: SpawnInput) => Effect.Effect<SpawnResult>) {
  return Opengrep.layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(mockSpawner(handler)),
    Layer.provide(httpLayer(new Response("unexpected", { status: 500 }))),
  )
}

function referenceLayer() {
  return Reference.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  )
}

function toolLayer(handler: (input: SpawnInput) => Effect.Effect<SpawnResult>) {
  return Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    opengrepLayer(handler),
    Session.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
    referenceLayer(),
  )
}

function withOpengrepPaths<A, E, R>(input: { bin: string; path: string }, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        bin: Global.Path.bin,
        PATH: process.env.PATH,
        Path: process.env.Path,
      }
      ;(Global.Path as { bin: string }).bin = input.bin
      process.env.PATH = input.path
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { bin: string }).bin = previous.bin
        if (previous.PATH === undefined) delete process.env.PATH
        else process.env.PATH = previous.PATH
        if (previous.Path === undefined) delete process.env.Path
        else process.env.Path = previous.Path
      }),
  )
}

function withOpengrepBinary<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const bin = path.join(test.directory, "bin")
    const search = path.join(test.directory, "search")
    const binary = path.join(bin, process.platform === "win32" ? "opengrep.exe" : "opengrep")
    yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))
    yield* Effect.promise(() => Bun.write(binary, "fake opengrep"))
    if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(binary, 0o755))
    return yield* withOpengrepPaths({ bin, path: search }, effect)
  })
}

describe("file.opengrep", () => {
  testEffect(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      opengrepLayer((input) =>
        Effect.gen(function* () {
          const configIndex = input.args.indexOf("--config")
          commandCalls.push({
            command: input.command,
            args: [...input.args],
            config: yield* Effect.promise(() => Bun.file(input.args[configIndex + 1] ?? "").text()),
          })
          return { code: 0, stdout: JSON.stringify({ results: [] }) }
        }),
      ),
    ),
  ).instance("builds structured command args", () =>
    withOpengrepBinary(
      Effect.gen(function* () {
        const test = yield* TestInstance
        commandCalls.length = 0
        const opengrep = yield* Opengrep.Service
        yield* opengrep.search({
          cwd: test.directory,
          pattern: "$X == 1",
          language: "typescript",
          include: "*.ts",
          exclude: "node_modules/**",
        })

        const call = commandCalls[0]
        if (!call) throw new Error("opengrep was not spawned")
        expect(call.command).toBe(path.join(test.directory, "bin", process.platform === "win32" ? "opengrep.exe" : "opengrep"))
        expect(call.args).toContain("--json")
        expect(call.args).toContain("--config")
        expect(call.args).toContain("--include")
        expect(call.args).toContain("*.ts")
        expect(call.args).toContain("--exclude")
        expect(call.args).toContain("node_modules/**")
        expect(call.args).toContain("--")
        expect(call.args.at(-1)).toBe(".")
        expect(call.config).toContain('"pattern": "$X == 1"')
        expect(call.config).toContain('"typescript"')
      }),
    ),
  )

  testEffect(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      Opengrep.layer.pipe(
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(mockSpawner(() => Effect.die("opengrep should not spawn"))),
        Layer.provide(httpLayer(new Response("not found", { status: 404 }))),
      ),
    ),
  ).instance("reports unavailable binary clearly when execution is attempted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const bin = path.join(test.directory, "bin")
      const search = path.join(test.directory, "search")
      yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))

      const exit = yield* withOpengrepPaths(
        { bin, path: search },
        (yield* Opengrep.Service).search({ cwd: test.directory, pattern: "foo" }).pipe(Effect.exit),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("opengrep is not installed or could not be downloaded")
    }),
  )

  testEffect(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      Opengrep.layer.pipe(
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(mockSpawner(() => Effect.die("opengrep should not spawn"))),
        Layer.provide(httpLayer(new Response("not found", { status: 404 }))),
      ),
    ),
  ).instance("reports unavailable binary clearly when cached binary disappears", () =>
    withOpengrepBinary(
      Effect.gen(function* () {
        const test = yield* TestInstance
        const binary = path.join(test.directory, "bin", process.platform === "win32" ? "opengrep.exe" : "opengrep")
        const opengrep = yield* Opengrep.Service
        expect(yield* opengrep.available()).toBe(true)
        yield* Effect.promise(() => fs.rm(binary))

        const exit = yield* opengrep.search({ cwd: test.directory, pattern: "foo" }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("opengrep is not installed or could not be downloaded")
      }),
    ),
  )

  testEffect(
    Layer.mergeAll(
      AppFileSystem.defaultLayer,
      opengrepLayer(() => Effect.succeed({ code: 0, stdout: "not json", stderr: "parse details" })),
    ),
  ).instance("reports invalid JSON concisely", () =>
    withOpengrepBinary(
      Effect.gen(function* () {
        const exit = yield* (yield* Opengrep.Service).search({ cwd: (yield* TestInstance).directory, pattern: "foo" }).pipe(
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("invalid opengrep output: parse details")
      }),
    ),
  )
})

describe("tool.opengrep", () => {
  testEffect(toolLayer(() => Effect.succeed({ code: 1, stdout: "" }))).instance(
    "returns empty output for no findings",
    () =>
      withOpengrepBinary(
        Effect.gen(function* () {
          const opengrep = yield* (yield* OpengrepTool).init()
          const result = yield* opengrep.execute({ pattern: "foo" }, ctx)

          expect(result.metadata.matches).toBe(0)
          expect(result.metadata.truncated).toBe(false)
          expect(result.output).toBe("[]")
        }),
      ),
  )

  testEffect(
    toolLayer(() =>
      Effect.succeed({
        code: 0,
        stdout: JSON.stringify({
          results: [
            {
              path: "./src/app.ts",
              start: { line: 3, col: 7 },
              extra: { message: "match", lines: "const value = 1" },
            },
          ],
        }),
      }),
    ),
  ).instance("maps findings to stable file line and match output", () =>
    withOpengrepBinary(
      Effect.gen(function* () {
        const test = yield* TestInstance
        const opengrep = yield* (yield* OpengrepTool).init()
        const result = yield* opengrep.execute({ pattern: "foo" }, ctx)

        expect(JSON.parse(result.output)).toEqual([
          {
            file: path.join(test.directory, "src/app.ts"),
            line: 3,
            column: 7,
            message: "match",
            match: "const value = 1",
          },
        ])
      }),
    ),
  )

  testEffect(
    toolLayer(() =>
      Effect.succeed({
        code: 0,
        stdout: JSON.stringify({
          results: [
            {
              path: "./src/app.ts",
              start: { line: 3, col: 7 },
              extra: { lines: "x".repeat(2001) },
            },
          ],
        }),
      }),
    ),
  ).instance("truncates long match snippets", () =>
    withOpengrepBinary(
      Effect.gen(function* () {
        const opengrep = yield* (yield* OpengrepTool).init()
        const result = yield* opengrep.execute({ pattern: "foo" }, ctx)
        const output = JSON.parse(result.output) as Array<{ match: string }>

        expect(output[0]?.match).toBe(`${"x".repeat(2000)}...`)
      }),
    ),
  )

  testEffect(toolLayer(() => Effect.succeed({ code: 0, stdout: JSON.stringify({ results: [] }) }))).instance(
    "does not request external permission for registered roots",
    () =>
      withOpengrepBinary(
        Effect.gen(function* () {
          const primary = yield* TestInstance
          const secondary = yield* tmpdirScoped()
          const requests: Array<{ permission: string }> = []
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })

          const opengrep = yield* (yield* OpengrepTool).init()
          yield* opengrep.execute(
            { pattern: "foo", path: secondary },
            {
              ...ctx,
              sessionID: info.id,
              ask: (request) =>
                Effect.sync(() => {
                  requests.push(request)
                }),
            },
          )

          expect(primary.directory).toBeTruthy()
          expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
        }),
      ),
  )

  testEffect(toolLayer(() => Effect.succeed({ code: 0, stdout: JSON.stringify({ results: [] }) }))).instance(
    "requests external permission for external directories",
    () =>
      withOpengrepBinary(
        Effect.gen(function* () {
          yield* TestInstance
          const external = yield* tmpdirScoped()
          const requests: Array<{ permission: string }> = []

          const opengrep = yield* (yield* OpengrepTool).init()
          yield* opengrep.execute(
            { pattern: "foo", path: external },
            {
              ...ctx,
              ask: (request) =>
                Effect.sync(() => {
                  requests.push(request)
                }),
            },
          )

          expect(requests.find((request) => request.permission === "external_directory")).toBeDefined()
        }),
      ),
  )
})

const commandCalls: Array<{
  command: string
  args: string[]
  config: string
}> = []
