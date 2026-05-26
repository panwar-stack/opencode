import path from "path"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { which } from "@/util/which"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const log = Log.create({ service: "opengrep" })
const VERSION = "1.22.0"
const MAX_ERROR_LENGTH = 2000
const MAX_MATCH_LENGTH = 2000
const PLATFORM = {
  "arm64-darwin": "opengrep_osx_arm64",
  "x64-darwin": "opengrep_osx_x86",
  "arm64-linux": "opengrep_musllinux_aarch64",
  "x64-linux": "opengrep_musllinux_x86",
  "x64-win32": "opengrep_windows_x86.exe",
} as const

const Location = Schema.Struct({
  line: Schema.Number,
  col: Schema.optional(Schema.Number),
})

const Finding = Schema.Struct({
  path: Schema.String,
  start: Location,
  extra: Schema.optional(
    Schema.Struct({
      lines: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})

const Output = Schema.Struct({
  results: Schema.Array(Finding),
})

const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(Output))

export interface FindingResult {
  file: string
  line: number
  column?: number
  message?: string
  match: string
}

export interface SearchInput {
  cwd: string
  pattern: string
  language?: string
  include?: string
  exclude?: string
  file?: string[]
  limit?: number
  signal?: AbortSignal
}

export interface SearchResult {
  items: FindingResult[]
  total: number
  truncated: boolean
}

export interface Interface {
  readonly path: () => Effect.Effect<string, Error>
  readonly available: () => Effect.Effect<boolean>
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, PlatformError | Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Opengrep") {}

export const use = serviceUse(Service)

function aborted(signal?: AbortSignal) {
  const err = signal?.reason
  if (err instanceof Error) return err
  const out = new Error("Aborted")
  out.name = "AbortError"
  return out
}

function waitForAbort(signal?: AbortSignal) {
  if (!signal) return Effect.never
  if (signal.aborted) return Effect.fail(aborted(signal))
  return Effect.callback<never, Error>((resume) => {
    const onabort = () => resume(Effect.fail(aborted(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })
}

function raceAbort<A, E, R>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) {
  return signal ? effect.pipe(Effect.raceFirst(waitForAbort(signal))) : effect
}

function truncate(text: string) {
  return text.length > MAX_ERROR_LENGTH ? text.substring(0, MAX_ERROR_LENGTH) + "..." : text
}

function truncateMatch(text: string) {
  return text.length > MAX_MATCH_LENGTH ? text.substring(0, MAX_MATCH_LENGTH) + "..." : text
}

function executionError(stderr: string, code: number) {
  const err = new Error(truncate(stderr.trim()) || `opengrep failed with code ${code}`)
  err.name = "OpengrepError"
  return err
}

function parse(stdout: string, stderr: string) {
  return decodeOutput(stdout).pipe(
    Effect.mapError(() =>
      new Error(`invalid opengrep output${stderr.trim() ? `: ${truncate(stderr.trim())}` : ""}`),
    ),
  )
}

function config(input: SearchInput) {
  return JSON.stringify(
    {
      rules: [
        {
          id: "opencode-opengrep",
          pattern: input.pattern,
          languages: [input.language ?? "generic"],
          message: "opengrep match",
          severity: "INFO",
        },
      ],
    },
    null,
    2,
  )
}

function searchArgs(input: SearchInput, configPath: string) {
  const args = ["--json", "--config", configPath]
  if (input.include) args.push("--include", input.include)
  if (input.exclude) args.push("--exclude", input.exclude)
  args.push("--", ...(input.file ?? ["."]))
  return args
}

function normalize(file: string) {
  return path.normalize(file.replace(/^\.[\\/]/, ""))
}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | ChildProcessSpawner | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const spawner = yield* ChildProcessSpawner

    const locate = Effect.fnUntraced(function* () {
      const binary = process.platform === "win32" ? "opengrep.exe" : "opengrep"
      const system = yield* Effect.sync(() => which(binary))
      if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

      const target = path.join(Global.Path.bin, binary)
      if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

      const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
      const asset = PLATFORM[platformKey]
      if (!asset) return yield* Effect.fail(new Error(`unsupported platform for opengrep: ${platformKey}`))

      const url = `https://github.com/opengrep/opengrep/releases/download/v${VERSION}/${asset}`
      log.info("downloading opengrep", { url })
      yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)

      const bytes = yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      )
      if (bytes.byteLength === 0) return yield* Effect.fail(new Error(`failed to download opengrep from ${url}`))

      yield* fs.writeWithDirs(target, new Uint8Array(bytes))
      if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      return target
    })
    const filepath = yield* Effect.cached(locate())

    const command = Effect.fnUntraced(function* (cwd: string, args: string[]) {
      const binary = yield* locate().pipe(
        Effect.mapError(() => new Error("opengrep is not installed or could not be downloaded")),
      )
      return ChildProcess.make(binary, args, {
        cwd,
        extendEnv: true,
        stdin: "ignore",
      })
    })

    const search: Interface["search"] = Effect.fn("Opengrep.search")(function* (input: SearchInput) {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "opengrep-" })
          const configPath = path.join(dir, "rule.json")
          yield* fs.writeWithDirs(configPath, config(input))

          const handle = yield* spawner.spawn(yield* command(input.cwd, searchArgs(input, configPath)))
          const [stdout, stderr, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )

          if (code !== 0 && code !== 1) return yield* Effect.fail(executionError(stderr, code))
          if (code === 1 && stdout.trim() === "") return { items: [], total: 0, truncated: false }

          const output = yield* parse(stdout, stderr)
          const limit = input.limit ?? 100
          const items = output.results.map((item) => ({
            file: normalize(item.path),
            line: item.start.line,
            column: item.start.col,
            message: item.extra?.message,
            match: truncateMatch(item.extra?.lines ?? ""),
          }))
          return {
            items: items.slice(0, limit),
            total: items.length,
            truncated: items.length > limit,
          }
        }),
      )

      return yield* raceAbort(program, input.signal)
    })

    return Service.of({
      path: () => filepath,
      available: () => filepath.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false))),
      search,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

export * as Opengrep from "./opengrep"
