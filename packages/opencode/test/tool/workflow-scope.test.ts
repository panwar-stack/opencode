import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { MessageID, SessionID } from "../../src/session/schema"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowState, type WorkflowStateFile } from "../../src/workflow/state"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const workflowID = "wf_scope_tool_test"
const sessionID = SessionID.make("ses_scope_tool_executor")

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

function makeCtx(asks: unknown[]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_scope_tool_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asks.push(input)
      }),
  }
}

const setupWorkflow = Effect.fn("WorkflowScopeToolTest.setupWorkflow")(function* (directory: string) {
  const now = WorkflowState.now()
  const state: WorkflowStateFile = {
    workflow_id: workflowID,
    title: "Scope tool test",
    request: "Scope tool test",
    state: "executing",
    artifact_dir: WorkflowArtifact.relativeArtifactDir(workflowID),
    created_at: now,
    updated_at: now,
    plan_branch: "plan/scope-tool-test",
    approved_spec_hash: "approved",
    approved_plan_commit: "HEAD",
    plan_pull_request: WorkflowState.emptyPullRequest(),
    code_pull_request: WorkflowState.emptyPullRequest(),
    sessions: [
      {
        id: String(sessionID),
        role: "executor",
        status: "active",
        task: "Execute approved scoped files",
        created_at: now,
        updated_at: now,
      },
    ],
  }

  yield* Effect.promise(() => fs.mkdir(WorkflowArtifact.workflowDir(directory, workflowID), { recursive: true }))
  yield* Effect.promise(() =>
    Bun.write(
      WorkflowArtifact.artifactPath(directory, workflowID, "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n",
    ),
  )
  yield* Effect.promise(() => WorkflowArtifact.writeState(directory, state))
})

const expectDenied = Effect.fn("WorkflowScopeToolTest.expectDenied")(function* (
  effect: Effect.Effect<unknown>,
  filePath: string,
  asks: unknown[],
) {
  const exit = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toHaveProperty("message", expect.stringContaining("Workflow scope denied edit"))
  expect(asks).toHaveLength(0)
  expect(yield* Effect.promise(() => Bun.file(filePath).exists())).toBe(false)
})

describe("tool workflow scope guard", () => {
  it.instance("blocks out-of-scope write/edit/apply_patch before mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* setupWorkflow(test.directory)

      const writeInfo = yield* WriteTool
      const write = yield* writeInfo.init()
      const writeAsks: unknown[] = []
      const writePath = path.join(test.directory, "docs", "write.md")
      yield* expectDenied(
        write.execute({ filePath: writePath, content: "out of scope" }, makeCtx(writeAsks)),
        writePath,
        writeAsks,
      )

      const editInfo = yield* EditTool
      const edit = yield* editInfo.init()
      const editAsks: unknown[] = []
      const editPath = path.join(test.directory, "docs", "edit.md")
      yield* expectDenied(
        edit.execute({ filePath: editPath, oldString: "", newString: "out of scope" }, makeCtx(editAsks)),
        editPath,
        editAsks,
      )

      const applyPatchInfo = yield* ApplyPatchTool
      const applyPatch = yield* applyPatchInfo.init()
      const applyPatchAsks: unknown[] = []
      const patchPath = path.join(test.directory, "docs", "patch.md")
      yield* expectDenied(
        applyPatch.execute(
          {
            patchText: "*** Begin Patch\n*** Add File: docs/patch.md\n+out of scope\n*** End Patch",
          },
          makeCtx(applyPatchAsks),
        ),
        patchPath,
        applyPatchAsks,
      )
    }),
  )
})
