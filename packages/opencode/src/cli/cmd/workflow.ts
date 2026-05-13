import type { Argv } from "yargs"
import { Effect, Layer } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance"
import { Bus } from "@/bus"
import { Workflow } from "@/workflow/workflow"
import { WorkflowReview } from "@/workflow/review"
import { WorkflowState, type WorkflowStateFile } from "@/workflow/state"
import { SessionPrompt } from "@/session/prompt"
import { UI } from "../ui"
import { EOL } from "os"

type WorkflowArgs = {
  readonly workflowID: string
}

const workflowLayer = Layer.mergeAll(WorkflowReview.workflowLayer, SessionPrompt.defaultLayer).pipe(Layer.provide(Bus.layer))

function directoryFromInstance(ctx: InstanceContext) {
  return ctx.worktree || ctx.directory
}

function formatPr(label: string, pr: WorkflowStateFile["plan_pull_request"]) {
  if (!pr.number) return `${label}: none`
  return `${label}: #${pr.number} ${pr.review_state}${pr.url ? ` ${pr.url}` : ""}`
}

function prCell(pr: WorkflowStateFile["plan_pull_request"]) {
  if (!pr.number) return pr.review_state
  return `#${pr.number} ${pr.review_state}`
}

function openCommentSummary(state: WorkflowStateFile) {
  const plan = state.plan_pull_request.comments.filter((comment) => comment.state === "open").length
  const code = state.code_pull_request.comments.filter((comment) => comment.state === "open").length
  return {
    count: plan + code,
    text: `${plan + code} (plan ${plan}, code ${code})`,
  }
}

function validationSummary(state: WorkflowStateFile) {
  if (!state.last_validation) return "none"
  return `${state.last_validation.ok ? "ok" : "failed"} - ${state.last_validation.summary}`
}

function changedFilesSummary(state: WorkflowStateFile) {
  if (!state.last_validation?.files?.length) return "none"
  return state.last_validation.files.join(", ")
}

function statusLines(state: WorkflowStateFile) {
  const comments = openCommentSummary(state)
  return [
    `Workflow: ${state.workflow_id}`,
    `Title: ${state.title}`,
    `State: ${state.state}`,
    `Plan branch: ${state.plan_branch}`,
    state.code_branch ? `Code branch: ${state.code_branch}` : undefined,
    formatPr("Plan PR", state.plan_pull_request),
    state.plan_pull_request.branch ? `Plan PR branch: ${state.plan_pull_request.branch}` : undefined,
    state.plan_pull_request.head_commit ? `Plan PR head: ${state.plan_pull_request.head_commit}` : undefined,
    formatPr("Code PR", state.code_pull_request),
    state.code_pull_request.branch ? `Code PR branch: ${state.code_pull_request.branch}` : undefined,
    state.code_pull_request.head_commit ? `Code PR head: ${state.code_pull_request.head_commit}` : undefined,
    state.approved_spec_hash ? `Approved spec hash: ${state.approved_spec_hash}` : undefined,
    state.approved_plan_commit ? `Approved plan commit: ${state.approved_plan_commit}` : undefined,
    `Current task: ${state.current_task ?? "none"}`,
    `Active session: ${state.active_session_id ?? "none"}`,
    `Last validation: ${validationSummary(state)}`,
    `Changed files: ${changedFilesSummary(state)}`,
    `Open GitHub comments: ${comments.text}`,
    `User input needed: ${state.user_input_needed ?? "no"}`,
  ].filter((line): line is string => line !== undefined)
}

function printState(state: WorkflowStateFile, format?: string) {
  if (format === "json") {
    console.log(JSON.stringify(state, null, 2))
    return
  }
  console.log(statusLines(state).join(EOL))
}

function printWorkflowList(states: readonly WorkflowStateFile[], format?: string) {
  if (format === "json") {
    console.log(JSON.stringify(states, null, 2))
    return
  }
  if (states.length === 0) {
    console.log("No workflows found.")
    return
  }
  const idWidth = Math.max(12, ...states.map((state) => state.workflow_id.length))
  const stateWidth = Math.max(12, ...states.map((state) => state.state.length))
  const planWidth = Math.max(10, ...states.map((state) => prCell(state.plan_pull_request).length))
  const codeWidth = Math.max(10, ...states.map((state) => prCell(state.code_pull_request).length))
  const activeWidth = Math.max(14, ...states.map((state) => (state.active_session_id ?? "none").length))
  const taskWidth = Math.max(18, ...states.map((state) => (state.current_task ?? "none").length))
  console.log(
    [
      [
        `Workflow${" ".repeat(idWidth - 8)}`,
        `State${" ".repeat(stateWidth - 5)}`,
        `Plan PR${" ".repeat(planWidth - 7)}`,
        `Code PR${" ".repeat(codeWidth - 7)}`,
        "Comments",
        "Input",
        `Active session${" ".repeat(activeWidth - 14)}`,
        `Current task${" ".repeat(taskWidth - 12)}`,
        "Title",
      ].join("  "),
      ["─".repeat(idWidth), "─".repeat(stateWidth), "─".repeat(planWidth), "─".repeat(codeWidth), "─".repeat(8), "─".repeat(5), "─".repeat(activeWidth), "─".repeat(taskWidth), "─".repeat(40)].join(
        "  ",
      ),
      ...states.map((state) =>
        [
          state.workflow_id.padEnd(idWidth),
          state.state.padEnd(stateWidth),
          prCell(state.plan_pull_request).padEnd(planWidth),
          prCell(state.code_pull_request).padEnd(codeWidth),
          String(openCommentSummary(state).count).padEnd(8),
          (state.user_input_needed ? "yes" : "no").padEnd(5),
          (state.active_session_id ?? "none").padEnd(activeWidth),
          (state.current_task ?? "none").padEnd(taskWidth),
          state.title,
        ].join("  "),
      ),
    ].join(EOL),
  )
}

function printSessions(state: WorkflowStateFile, format?: string) {
  if (format === "json") {
    console.log(JSON.stringify(state.sessions, null, 2))
    return
  }
  if (state.sessions.length === 0) {
    console.log("No workflow sessions found.")
    return
  }
  const roleWidth = Math.max(10, ...state.sessions.map((session) => session.role.length))
  const idWidth = Math.max(20, ...state.sessions.map((session) => session.id.length))
  const taskWidth = Math.max(18, ...state.sessions.map((session) => session.task.length))
  console.log(
    [
      `Role${" ".repeat(roleWidth - 4)}  Session ID${" ".repeat(idWidth - 10)}  Status     Active  Task${" ".repeat(taskWidth - 4)}`,
      `${"─".repeat(roleWidth)}  ${"─".repeat(idWidth)}  ${"─".repeat(9)}  ${"─".repeat(6)}  ${"─".repeat(taskWidth)}`,
      ...state.sessions.map((session) =>
        [session.role.padEnd(roleWidth), session.id.padEnd(idWidth), session.status.padEnd(9), (session.id === state.active_session_id ? "yes" : "no").padEnd(6), session.task.padEnd(taskWidth)].join(
          "  ",
        ),
      ),
    ].join(EOL),
  )
}

function printSession(state: WorkflowStateFile, sessionID: string, format?: string) {
  const session = state.sessions.find((item) => item.id === sessionID)
  if (!session) throw new Error(`Workflow session not found: ${sessionID}`)
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          workflow_id: state.workflow_id,
          title: state.title,
          state: state.state,
          current_task: state.current_task,
          active_session_id: state.active_session_id,
          user_input_needed: state.user_input_needed,
          last_validation: state.last_validation,
          plan_pull_request: state.plan_pull_request,
          code_pull_request: state.code_pull_request,
          open_comments: WorkflowState.openComments(state),
          session,
        },
        null,
        2,
      ),
    )
    return
  }
  return console.log(
    [
      `Workflow: ${state.workflow_id}`,
      `Title: ${state.title}`,
      `State: ${state.state}`,
      `Session: ${session.id}`,
      `Role: ${session.role}`,
      `Status: ${session.status}`,
      `Active: ${session.id === state.active_session_id ? "yes" : "no"}`,
      `Task: ${session.task}`,
      formatPr("Plan PR", state.plan_pull_request),
      formatPr("Code PR", state.code_pull_request),
      `Current task: ${state.current_task ?? "none"}`,
      `Last validation: ${validationSummary(state)}`,
      `Open GitHub comments: ${openCommentSummary(state).text}`,
      `User input needed: ${state.user_input_needed ?? "no"}`,
      session.github_comment_url ? `GitHub comment: ${session.github_comment_url}` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join(EOL),
  )
}

function instructionText(instruction: string | readonly string[]) {
  if (typeof instruction === "string") return instruction
  return instruction.join(" ")
}

function withWorkflowEff<A, E>(eff: Effect.Effect<A, E, Workflow.Service>) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("No project instance is available.")
    return yield* eff.pipe(
      Effect.provide(workflowLayer),
      Effect.mapError((e) => new CliError({ message: e instanceof Error ? e.message : String(e) })),
    )
  })
}

export const WorkflowCommand = cmd({
  command: "workflow",
  describe: "manage GitHub-reviewed autonomous workflows",
  builder: (yargs: Argv) =>
    yargs
      .command(WorkflowStartCommand)
      .command(WorkflowStatusCommand)
      .command(WorkflowSubmitCommand)
      .command(WorkflowSyncCommand)
      .command(WorkflowListCommand)
      .command(WorkflowSessionsCommand)
      .command(WorkflowBranchCommand)
      .command(WorkflowDiffCommand)
      .command(WorkflowCommitCommand)
      .command(WorkflowPauseCommand)
      .command(WorkflowResumeCommand)
      .command(WorkflowRevisePlanCommand)
      .command(WorkflowRunCommand)
      .command(WorkflowSessionCommand)
      .command(WorkflowSteerCommand)
      .command(WorkflowAmendmentCommand)
      .command(WorkflowRecoverCommand)
      .demandCommand(),
  async handler() {},
})

export const WorkflowStartCommand = effectCmd({
  command: "start <title>",
  describe: "start a workflow and create plan artifacts",
  builder: (yargs) =>
    yargs
      .positional("title", {
        describe: "workflow title",
        type: "string",
        demandOption: true,
      })
      .option("local-draft", {
        describe: "keep workflow in local draft state",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.start")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const state = yield* svc.start({
          directory,
          title: args.title,
          localDraft: args.localDraft,
        })
        printState(state, args.format)
      }),
    )
  }),
})

export const WorkflowStatusCommand = effectCmd({
  command: "status [workflowID]",
  describe: "show workflow status",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.status")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const states = yield* svc.all(directory)
        const state = args.workflowID ? yield* svc.get(directory, args.workflowID) : states.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
        if (!state) return yield* fail("No workflows found.")
        printState(state, args.format)
      }),
    )
  }),
})

export const WorkflowListCommand = effectCmd({
  command: "list",
  describe: "list workflows",
  builder: (yargs) =>
    yargs.option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    }),
  handler: Effect.fn("Cli.workflow.list")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printWorkflowList(yield* svc.all(directory), args.format)
      }),
    )
  }),
})

export const WorkflowSessionsCommand = effectCmd({
  command: "sessions <workflowID>",
  describe: "list workflow sessions",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.sessions")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printSessions(yield* svc.get(directory, args.workflowID), args.format)
      }),
    )
  }),
})

export const WorkflowSubmitCommand = cmd({
  command: "submit",
  describe: "submit workflow artifacts",
  builder: (yargs: Argv) => yargs.command(WorkflowSubmitPlanCommand).command(WorkflowSubmitCodeCommand).demandCommand(),
  async handler() {},
})

export const WorkflowSubmitPlanCommand = effectCmd({
  command: "plan <workflowID>",
  describe: "submit the workflow plan pull request",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("base", {
        describe: "base branch or ref",
        type: "string",
        default: "dev",
      })
      .option("dry-run", {
        describe: "validate without pushing or creating a pull request",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.submit.plan")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const state = yield* svc.submitPlan({
          directory,
          workflowID: args.workflowID,
          base: args.base,
          dryRun: args.dryRun,
        })
        printState(state, args.format)
      }),
    )
  }),
})

export const WorkflowRevisePlanCommand = effectCmd({
  command: "revise plan <workflowID>",
  describe: "revise the workflow plan from review feedback",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("instruction", {
        describe: "revision instruction",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.revise.plan")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.revisePlan({
            directory,
            workflowID: args.workflowID,
            instruction: args.instruction,
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowRunCommand = effectCmd({
  command: "run <workflowID>",
  describe: "run the approved workflow implementation",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("dry-run", {
        describe: "show the execution plan without starting implementation",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.run")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.run({
            directory,
            workflowID: args.workflowID,
            dryRun: args.dryRun,
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowSubmitCodeCommand = effectCmd({
  command: "code <workflowID>",
  describe: "submit the workflow code pull request",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("base", {
        describe: "base branch or ref",
        type: "string",
        default: "dev",
      })
      .option("dry-run", {
        describe: "validate without pushing or creating a pull request",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.submit.code")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.submitCode({
            directory,
            workflowID: args.workflowID,
            base: args.base,
            dryRun: args.dryRun,
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowSyncCommand = cmd({
  command: "sync",
  describe: "sync workflow integrations",
  builder: (yargs: Argv) => yargs.command(WorkflowSyncGithubCommand).demandCommand(),
  async handler() {},
})

export const WorkflowSyncGithubCommand = effectCmd({
  command: "github <workflowID>",
  describe: "sync GitHub pull request review state and comments",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.sync.github")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(yield* svc.syncGithub({ directory, workflowID: args.workflowID }), args.format)
      }),
    )
  }),
})

export const WorkflowBranchCommand = effectCmd({
  command: "branch <workflowID>",
  describe: "show workflow branches",
  builder: (yargs) =>
    yargs.positional("workflowID", {
      describe: "workflow ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.workflow.branch")(function* (args: WorkflowArgs) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const branches = svc.branch(yield* svc.get(directory, args.workflowID))
        console.log(`Plan: ${branches.plan}`)
        if (branches.code) console.log(`Code: ${branches.code}`)
      }),
    )
  }),
})

export const WorkflowDiffCommand = effectCmd({
  command: "diff <workflowID>",
  describe: "show workflow diff from base",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("base", {
        describe: "base branch or ref",
        type: "string",
        default: "origin/dev",
      }),
  handler: Effect.fn("Cli.workflow.diff")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        console.log(yield* svc.diff(directory, args.workflowID, args.base))
      }),
    )
  }),
})

export const WorkflowCommitCommand = effectCmd({
  command: "commit <workflowID>",
  describe: "commit workflow plan artifacts",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("message", {
        alias: "m",
        describe: "commit message",
        type: "string",
      }),
  handler: Effect.fn("Cli.workflow.commit")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const commit = yield* svc.commitPlan({
          directory,
          workflowID: args.workflowID,
          message: args.message,
        })
        UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}Committed workflow plan ${commit}${UI.Style.TEXT_NORMAL}`)
      }),
    )
  }),
})

export const WorkflowPauseCommand = effectCmd({
  command: "pause <workflowID>",
  describe: "pause a workflow",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.pause")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(yield* svc.pause(directory, args.workflowID), args.format)
      }),
    )
  }),
})

export const WorkflowResumeCommand = effectCmd({
  command: "resume <workflowID>",
  describe: "resume a workflow",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.resume")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(yield* svc.resume(directory, args.workflowID), args.format)
      }),
    )
  }),
})

export const WorkflowSessionCommand = effectCmd({
  command: "session <workflowID> <sessionID>",
  describe: "show a workflow session",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .positional("sessionID", {
        describe: "workflow session ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.session")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        const result = yield* svc.sessionContext(directory, args.workflowID, args.sessionID)
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        printSession(result.workflow, result.session.id, args.format)
      }),
    )
  }),
})

export const WorkflowSteerCommand = effectCmd({
  command: "steer <workflowID> <sessionID> <instruction...>",
  describe: "send steering instructions to a workflow session",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .positional("sessionID", {
        describe: "workflow session ID",
        type: "string",
        demandOption: true,
      })
      .positional("instruction", {
        describe: "instruction text",
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.steer")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.steer({
            directory,
            workflowID: args.workflowID,
            sessionID: args.sessionID,
            instruction: instructionText(args.instruction),
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowAmendmentCommand = cmd({
  command: "amendment",
  describe: "manage scope amendment requests",
  builder: (yargs: Argv) => yargs.command(WorkflowAmendmentApproveCommand).command(WorkflowAmendmentRejectCommand).demandCommand(),
  async handler() {},
})

export const WorkflowAmendmentApproveCommand = effectCmd({
  command: "approve <workflowID>",
  describe: "approve a scope amendment request",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("reason", {
        describe: "reason for approving the amendment",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.amendment.approve")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.processAmendment({
            directory,
            workflowID: args.workflowID,
            approve: true,
            reason: args.reason,
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowAmendmentRejectCommand = effectCmd({
  command: "reject <workflowID>",
  describe: "reject a scope amendment request",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("reason", {
        describe: "reason for rejecting the amendment",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.amendment.reject")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(
          yield* svc.processAmendment({
            directory,
            workflowID: args.workflowID,
            approve: false,
            reason: args.reason,
          }),
          args.format,
        )
      }),
    )
  }),
})

export const WorkflowRecoverCommand = effectCmd({
  command: "recover <workflowID>",
  describe: "recover a workflow from failed, paused, or interrupted state",
  builder: (yargs) =>
    yargs
      .positional("workflowID", {
        describe: "workflow ID",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workflow.recover")(function* (args) {
    return yield* withWorkflowEff(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        const ctx = yield* InstanceRef
        const directory = (ctx as InstanceContext).worktree || (ctx as InstanceContext).directory
        printState(yield* svc.recover(directory, args.workflowID), args.format)
      }),
    )
  }),
})
