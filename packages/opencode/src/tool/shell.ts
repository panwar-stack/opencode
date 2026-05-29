import { Effect, Fiber, Stream } from "effect"
import os from "os"
import { createWriteStream, existsSync } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { ToolPath } from "./path"
import { Session } from "@/session/session"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const SANDBOX_IMAGE = "ghcr.io/anomalyco/build/bun-node:24.04"
const SANDBOX_PROXY_PORT = 3128

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

type SandboxMount = {
  source: string
  target: string
  writable: boolean
}

type SandboxProfile = NonNullable<NonNullable<Config.Info["sandbox"]>["profiles"]>[string]
type SandboxNetwork = NonNullable<SandboxProfile["network"]>

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

function sandboxCmd(command: string, cwd: string, env: NodeJS.ProcessEnv, mounts: SandboxMount[], network?: SandboxNetwork) {
  if (network?.mode === "allowlist") return sandboxAllowlistCmd(command, cwd, env, mounts, network.hosts)
  return ChildProcess.make(
    "docker",
    [
      "run",
      "--rm",
      ...(network?.mode === "full" ? [] : ["--network", "none"]),
      "--workdir",
      cwd,
      ...Object.keys(env)
        .filter((key) => env[key] !== undefined)
        .flatMap((key) => ["--env", key]),
      ...mounts.flatMap((mount) => [
        "--mount",
        `type=bind,source=${mount.source},target=${mount.target}${mount.writable ? "" : ",readonly"}`,
      ]),
      SANDBOX_IMAGE,
      "/bin/bash",
      "-lc",
      command,
    ],
    {
      cwd,
      env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    },
  )
}

function sandboxAllowlistCmd(command: string, cwd: string, env: NodeJS.ProcessEnv, mounts: SandboxMount[], hosts: string[]) {
  return ChildProcess.make(
    process.execPath,
    [
      "--eval",
      SANDBOX_ALLOWLIST_ORCHESTRATOR,
      JSON.stringify({
        image: SANDBOX_IMAGE,
        command,
        cwd,
        env: Object.fromEntries(Object.keys(env).flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))),
        mounts,
        hosts,
        proxyPort: SANDBOX_PROXY_PORT,
        proxyScript: SANDBOX_PROXY_SCRIPT,
      }),
    ],
    {
      cwd,
      env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    },
  )
}

const SANDBOX_ALLOWLIST_ORCHESTRATOR = String.raw`
const spec = JSON.parse(process.argv[2])
const suffix = String(process.pid) + "-" + Date.now().toString(36)
const network = "opencode-allowlist-" + suffix
const proxy = "opencode-proxy-" + suffix
const command = "opencode-command-" + suffix
const children = new Set()

function dockerSync(args) {
  Bun.spawnSync(["docker", ...args], { stdout: "ignore", stderr: "ignore" })
}

function cleanupSync() {
  dockerSync(["rm", "-f", command])
  dockerSync(["rm", "-f", proxy])
  dockerSync(["network", "rm", network])
}

async function docker(args, options = {}) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
    env: process.env,
  })
  children.add(child)
  const code = await child.exited
  children.delete(child)
  if (code !== 0 && options.check !== false) throw new Error("docker " + args.join(" ") + " failed")
  if (!options.capture) return code
  return await new Response(child.stdout).text()
}

async function stop(signal) {
  for (const child of children) child.kill()
  cleanupSync()
  process.exit(signal === "SIGTERM" ? 143 : 130)
}

process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))

async function waitForProxy() {
  for (let i = 0; i < 20; i++) {
    const code = await docker([
      "exec",
      proxy,
      "node",
      "-e",
      "require('net').connect(Number(process.env.OPENCODE_PROXY_PORT),'127.0.0.1',()=>process.exit(0)).on('error',()=>process.exit(1))",
    ], { check: false })
    if (code === 0) return
    await Bun.sleep(50)
  }
  throw new Error("sandbox allowlist proxy did not become ready")
}

try {
  await docker(["network", "create", "--internal", network])
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    proxy,
    "--network",
    "bridge",
    "--env",
    "OPENCODE_ALLOWLIST_JSON=" + JSON.stringify(spec.hosts),
    "--env",
    "OPENCODE_PROXY_PORT=" + String(spec.proxyPort),
    spec.image,
    "node",
    "-e",
    spec.proxyScript,
  ])
  await docker(["network", "connect", "--alias", "proxy", network, proxy])
  await waitForProxy()
  const code = await docker([
    "run",
    "--rm",
    "--name",
    command,
    "--network",
    network,
    "--workdir",
    spec.cwd,
    ...Object.keys(spec.env).flatMap((key) => ["--env", key + "=" + spec.env[key]]),
    "--env",
    "HTTP_PROXY=http://proxy:" + String(spec.proxyPort),
    "--env",
    "http_proxy=http://proxy:" + String(spec.proxyPort),
    "--env",
    "HTTPS_PROXY=http://proxy:" + String(spec.proxyPort),
    "--env",
    "https_proxy=http://proxy:" + String(spec.proxyPort),
    "--env",
    "ALL_PROXY=http://proxy:" + String(spec.proxyPort),
    "--env",
    "all_proxy=http://proxy:" + String(spec.proxyPort),
    "--env",
    "NO_PROXY=",
    "--env",
    "no_proxy=",
    ...spec.mounts.flatMap((mount) => [
      "--mount",
      "type=bind,source=" + mount.source + ",target=" + mount.target + (mount.writable ? "" : ",readonly"),
    ]),
    spec.image,
    "/bin/bash",
    "-lc",
    spec.command,
  ], { check: false })
  cleanupSync()
  process.exit(code)
} catch (error) {
  cleanupSync()
  process.stderr.write(error instanceof Error ? error.message + "\n" : String(error) + "\n")
  process.exit(1)
}
`

const SANDBOX_PROXY_SCRIPT = String.raw`
const http = require("http")
const net = require("net")
const dns = require("dns").promises
const allowed = new Set(JSON.parse(process.env.OPENCODE_ALLOWLIST_JSON).map((host) => host.toLowerCase().replace(/\.$/, "")))

function ipv4Value(address) {
  return address.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0
}

function inRange(value, start, bits) {
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (ipv4Value(start) & mask)
}

function isPrivateOrReserved(address) {
  if (net.isIP(address) === 4) {
    const value = ipv4Value(address)
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some((range) => inRange(value, range[0], range[1]))
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
  }
  return true
}

async function resolveAllowedHost(input) {
  const host = input.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")
  if (net.isIP(host)) throw new Error("direct IP egress is blocked")
  if (!allowed.has(host)) throw new Error("host is not allowlisted")
  const addresses = await dns.lookup(host, { all: true })
  if (addresses.length === 0 || addresses.some((item) => isPrivateOrReserved(item.address))) {
    throw new Error("host resolves to a private or reserved address")
  }
  return addresses[0].address
}

function reject(socket, message) {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n" + message + "\n")
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) throw new Error("missing URL")
    const url = new URL(req.url)
    const address = await resolveAllowedHost(url.hostname)
    const upstream = http.request({ host: address, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host } }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on("error", (error) => {
      res.writeHead(502)
      res.end(String(error))
    })
    req.pipe(upstream)
  } catch (error) {
    res.writeHead(403)
    res.end(error instanceof Error ? error.message : String(error))
  }
})

server.on("connect", async (req, socket, head) => {
  try {
    const [host, port = "443"] = String(req.url).split(":")
    const address = await resolveAllowedHost(host)
    const upstream = net.connect(Number(port), address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", (error) => reject(socket, String(error)))
  } catch (error) {
    reject(socket, error instanceof Error ? error.message : String(error))
  }
})

server.listen(Number(process.env.OPENCODE_PROXY_PORT), "0.0.0.0")
`

function sandboxTokenPath(token: string, workspace: string) {
  if (token === "workspace") return workspace
  if (token === "systemRuntime") return path.dirname(process.execPath)
  if (token === "temporaryDirectory") return os.tmpdir()
  if (token.startsWith("workspace/")) return path.join(workspace, token.slice("workspace/".length))
  if (token.startsWith("home/")) return path.join(os.homedir(), token.slice("home/".length))
}

function sandboxMounts(profile: SandboxProfile, workspace: string) {
  const filesystem = profile.filesystem
  const hasFilesystemTokens = Boolean(
    filesystem && [...(filesystem.read ?? []), ...(filesystem.write ?? []), ...(filesystem.protected ?? [])].length > 0,
  )
  const hasTemporaryDirectoryMount = Boolean(
    filesystem && [...(filesystem.read ?? []), ...(filesystem.write ?? [])].includes("temporaryDirectory"),
  )
  const protectedPaths = new Set(
    (filesystem?.protected ?? []).flatMap((token) => {
      const resolved = sandboxTokenPath(token, workspace)
      return resolved ? [resolved] : []
    }),
  )
  const writable = new Set(
    (hasFilesystemTokens ? (filesystem?.write ?? []) : ["workspace"]).flatMap((token) => {
      const resolved = sandboxTokenPath(token, workspace)
      return resolved ? [resolved] : []
    }),
  )
  const readable = new Set(
    (hasFilesystemTokens ? (filesystem?.read ?? []) : ["systemRuntime"]).flatMap((token) => {
      const resolved = sandboxTokenPath(token, workspace)
      return resolved ? [resolved] : []
    }),
  )
  const mounts = new Map<string, SandboxMount>()
  for (const source of writable) {
    if (source.length > 0) mounts.set(source, { source, target: source, writable: !protectedPaths.has(source) })
  }
  for (const source of readable) {
    if (source.length > 0 && !mounts.has(source)) mounts.set(source, { source, target: source, writable: false })
  }
  for (const source of protectedPaths) {
    if (source.length > 0 && (source !== os.tmpdir() || hasTemporaryDirectoryMount) && existsSync(source)) {
      mounts.set(source, { source, target: source, writable: false })
    }
  }
  return Array.from(mounts.values())
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    const session = yield* Session.Service

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      session: Session.Interface,
      ctx: Tool.Context,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || (yield* ToolPath.insideWithSession(session, ctx, resolved))) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        process?: ChildProcess.Command
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(input.process ?? cmd(input.shell, input.command, input.cwd, input.env))

          const outputFiber = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          yield* Fiber.join(outputFiber).pipe(Effect.ignore)

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              yield* InstanceState.context
              const primary = yield* ToolPath.primaryWithSession(session, ctx)
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, primary.directory, shell)
                : primary.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, session, ctx)
                  if (!(yield* ToolPath.insideWithSession(session, ctx, cwd))) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )
              const env = yield* shellEnv(ctx, cwd)
              const sandboxProcess = yield* Effect.gen(function* () {
                if (cfg.sandbox?.enabled !== true) return
                if (process.platform === "win32") throw new Error("Sandbox is enabled but Docker is unavailable")
                const profileName = cfg.sandbox.defaultProfile ?? "workspace"
                const profile = cfg.sandbox.profiles?.[profileName]
                if (!profile) throw new Error("Sandbox profile is missing.")
                if (profile.network?.mode === "full" && profile.network.requiresApproval !== false) {
                  const pattern = `sandbox_network:full:${profileName}`
                  yield* ctx.ask({
                    permission: "sandbox_network",
                    patterns: [pattern],
                    always: [pattern],
                    metadata: {
                      profile: profileName,
                      mode: "full",
                      command: params.command,
                      description: params.description,
                    },
                  })
                }
                const code = yield* spawner
                  .exitCode(ChildProcess.make("docker", ["--version"], { stdin: "ignore" }))
                  .pipe(
                    Effect.map((code) => Number(code)),
                    Effect.orElseSucceed(() => 1),
                  )
                if (code !== 0) throw new Error("Sandbox is enabled but Docker is unavailable")
                return sandboxCmd(params.command, cwd, env, sandboxMounts(profile, primary.directory), profile.network)
              })

              return yield* run(
                {
                  shell,
                  command: params.command,
                  process: sandboxProcess,
                  cwd,
                  env,
                  timeout,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
