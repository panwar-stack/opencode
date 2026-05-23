import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode memory CLI", () => {
  cliIt.live(
    "indexes, searches, examines, and clears local commit memory",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const hash = yield* Effect.promise(() => setupRepository(home))
        const env = { OPENCODE_DB: path.join(home, "memory.db") }

        const indexed = yield* opencode.spawn(["memory", "index", "--max-commits", "10", "--no-github"], {
          env,
          timeoutMs: 60_000,
        })
        opencode.expectExit(indexed, 0, "memory index")
        expect(indexed.stdout).toContain("Commits indexed: 1")

        const status = yield* opencode.spawn(["memory", "status"], { env, timeoutMs: 60_000 })
        opencode.expectExit(status, 0, "memory status")
        expect(status.stdout).toContain("Commits: 1")
        expect(status.stdout).toContain("File activity: 1")

        const search = yield* opencode.spawn(["memory", "search", "commit", "login redirect"], { env, timeoutMs: 60_000 })
        opencode.expectExit(search, 0, "memory search commit")
        expect(search.stdout).toContain(hash)
        expect(search.stdout).toContain("Changed files: src/auth.ts")

        const examine = yield* opencode.spawn(["memory", "examine", "commit", hash], { env, timeoutMs: 60_000 })
        opencode.expectExit(examine, 0, "memory examine commit")
        expect(examine.stdout).toContain("historical memory")
        expect(examine.stdout).toContain("src/auth.ts")

        const cleared = yield* opencode.spawn(["memory", "clear"], { env, timeoutMs: 60_000 })
        opencode.expectExit(cleared, 0, "memory clear")
        expect(cleared.stdout).toContain("Cleared: yes")
      }),
    120_000,
  )
})

async function setupRepository(dir: string) {
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(path.join(dir, "src/auth.ts"), "export const loginRedirect = true\n")
  await $`git add src/auth.ts`.cwd(dir).quiet()
  await $`git commit -m ${"fix login redirect"}`.cwd(dir).quiet()
  return (await $`git rev-parse --short=12 HEAD`.cwd(dir).text()).trim()
}
