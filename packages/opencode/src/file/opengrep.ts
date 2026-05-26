import path from "path"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { which } from "@/util/which"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

const log = Log.create({ service: "opengrep" })
const VERSION = "1.22.0"
const PLATFORM = {
  "arm64-darwin": "opengrep_osx_arm64",
  "x64-darwin": "opengrep_osx_x86",
  "arm64-linux": "opengrep_musllinux_aarch64",
  "x64-linux": "opengrep_musllinux_x86",
  "x64-win32": "opengrep_windows_x86.exe",
} as const

export interface Interface {
  readonly path: () => Effect.Effect<string, Error>
  readonly available: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Opengrep") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

    const filepath = yield* Effect.cached(
      Effect.gen(function* () {
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
      }),
    )

    return Service.of({
      path: () => filepath,
      available: () => filepath.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false))),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as Opengrep from "./opengrep"
