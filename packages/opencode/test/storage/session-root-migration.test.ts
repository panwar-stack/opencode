import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"

const target = "20260519040526_session_roots"

function migrations() {
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.split("_")[0]),
      sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf-8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe("session root migration", () => {
  test("backfills primary roots for existing sessions", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    const entries = migrations()
    const index = entries.findIndex((entry) => entry.name === target)

    expect(index).toBeGreaterThan(0)

    migrate(db, entries.slice(0, index))
    sqlite.run(
      "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["project_1", "/tmp/project", "git", "project", 1, 1, "[]"],
    )
    sqlite.run(
      "INSERT INTO session (id, project_id, slug, directory, path, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["ses_1", "project_1", "slug", "/tmp/project/packages/app", "packages/app", "title", "1.0.0", 2, 3],
    )

    expect(() => migrate(db, entries.slice(index))).not.toThrow()
    expect(
      sqlite
        .query("SELECT session_id, directory, worktree, project_id, path, created, `primary` FROM session_root")
        .get(),
    ).toEqual({
      session_id: "ses_1",
      directory: "/tmp/project/packages/app",
      worktree: "/tmp/project",
      project_id: "project_1",
      path: "packages/app",
      created: 2,
      primary: 1,
    })
    expect(() =>
      sqlite.run(
        "INSERT INTO session_root (id, session_id, directory, worktree, project_id, created, `primary`) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["sesroot_duplicate", "ses_1", "/tmp/project/packages/app", "/tmp/project", "project_1", 4, 0],
      ),
    ).toThrow()
  })
})
