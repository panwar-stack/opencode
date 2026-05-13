import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useTheme } from "@tui/context/theme"
import { Spinner } from "@tui/component/spinner"
import { useBindings } from "../keymap"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import type { WorkflowStateFile, PullRequestState, ReviewState, WorkflowSession } from "@/workflow/state"
import { WorkflowStates } from "@/workflow/state"
import * as WorkflowService from "@/workflow/workflow"
import path from "path"
import { readdir } from "fs/promises"
import { spawnSync } from "child_process"

export type WorkflowState = (typeof WorkflowStates)[number]

type WorkflowTab = "spec" | "tasks" | "impact" | "github" | "sessions" | "changes" | "decisions" | "amendments"
type PullRequestDisplay = PullRequestState & {
  readonly reviewers?: readonly string[]
  readonly latest_review_at?: string
}
type WorkflowSessionDisplay = WorkflowSession & {
  readonly agent?: string
  readonly files_touched?: readonly string[]
  readonly input_needed?: string
}
type WorkflowStateDisplay = WorkflowStateFile & {
  readonly spec_version?: string
}
export type WorkflowDetailActionID =
  | "open_session"
  | "steer"
  | "sync"
  | "revise"
  | "submit_plan"
  | "run"
  | "submit_code"
  | "pause"
  | "resume"
  | "approve_amendment"
  | "reject_amendment"
export type WorkflowDetailAction = { id: WorkflowDetailActionID; label: string; enabled: boolean; visible: boolean }

const tabs: { id: WorkflowTab; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "tasks", label: "Tasks" },
  { id: "impact", label: "Impact" },
  { id: "github", label: "GitHub" },
  { id: "sessions", label: "Sessions" },
  { id: "changes", label: "Changes" },
  { id: "decisions", label: "Decisions" },
  { id: "amendments", label: "Amendments" },
]

export function workflowTabs() {
  return tabs
}

const stateLabels: Record<WorkflowState, string> = {
  created: "Created",
  drafting_spec: "Drafting Spec",
  submitting_plan_pull_request: "Submitting Plan PR",
  awaiting_plan_review: "Awaiting Plan Review",
  addressing_plan_comments: "Addressing Plan Comments",
  plan_approved: "Plan Approved",
  executing: "Executing",
  validating: "Validating",
  submitting_code_pull_request: "Submitting Code PR",
  awaiting_code_review: "Awaiting Code Review",
  addressing_code_comments: "Addressing Code Comments",
  needs_amendment: "Needs Amendment",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
}

const reviewLabels: Record<ReviewState, string> = {
  none: "-",
  pending: "Pending",
  commented: "Commented",
  changes_requested: "Changes Requested",
  approved: "Approved",
  merged: "Merged",
}

export function workflowOpenCommentCount(workflow: WorkflowStateFile) {
  return (
    workflow.plan_pull_request.comments.filter((comment) => comment.state === "open").length +
    workflow.code_pull_request.comments.filter((comment) => comment.state === "open").length
  )
}

export function workflowNeedsInput(workflow: WorkflowStateFile) {
  return Boolean(
    workflow.user_input_needed || workflow.sessions.some((session) => (session as WorkflowSessionDisplay).input_needed),
  )
}

export function workflowActiveSession(workflow: WorkflowStateFile) {
  return workflow.sessions.find((session) => session.id === workflow.active_session_id)
}

export function workflowSessionPrompt(workflow: WorkflowStateFile, session: WorkflowSession) {
  return {
    input: [
      `Workflow context: ${workflow.title} (${workflow.workflow_id})`,
      `State: ${workflow.state}`,
      workflow.current_task ? `Current task: ${workflow.current_task}` : undefined,
      workflow.approved_spec_hash ? `Approved spec hash: ${workflow.approved_spec_hash}` : undefined,
      workflow.approved_plan_commit ? `Approved plan commit: ${workflow.approved_plan_commit}` : undefined,
      `Session: ${session.role} ${session.id}`,
      `Artifacts: ${workflow.artifact_dir}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    parts: [],
  }
}

export function workflowOpenSessionRoute(workflow: WorkflowStateFile, sessionID?: string) {
  const session = workflow.sessions.find((item) => item.id === (sessionID ?? workflow.active_session_id))
  if (!session) return undefined
  return {
    type: "session" as const,
    sessionID: session.id,
    prompt: workflowSessionPrompt(workflow, session),
  }
}

export function workflowSteeringInput(workflow: WorkflowStateFile, directory: string, instruction: string | null | undefined) {
  if (!workflow.active_session_id) return undefined
  const trimmed = instruction?.trim()
  if (!trimmed) return undefined
  return {
    directory,
    workflowID: workflow.workflow_id,
    sessionID: workflow.active_session_id,
    instruction: trimmed,
  }
}

export function workflowAmendmentInput(
  workflow: WorkflowStateFile,
  directory: string,
  approve: boolean,
  reason: string | null | undefined,
) {
  return {
    directory,
    workflowID: workflow.workflow_id,
    approve,
    reason: reason?.trim() || undefined,
  }
}

export function workflowStateLabel(state: WorkflowState) {
  return stateLabels[state]
}

export function workflowReviewLabel(state: ReviewState) {
  return reviewLabels[state]
}

export function workflowPullRequestLabel(pr: PullRequestState) {
  if (!pr.number) return "-"
  return `#${pr.number} (${workflowReviewLabel(pr.review_state)})`
}

export function workflowDetailActions(workflow: WorkflowStateFile) {
  const actions: WorkflowDetailAction[] = [
    { id: "open_session", label: "open session", enabled: Boolean(workflow.active_session_id), visible: true },
    { id: "steer", label: "steer", enabled: Boolean(workflow.active_session_id), visible: true },
    { id: "sync", label: "sync", enabled: true, visible: true },
    { id: "revise", label: "revise", enabled: true, visible: true },
    { id: "submit_plan", label: "submit plan", enabled: true, visible: true },
    { id: "run", label: "run", enabled: true, visible: true },
    { id: "submit_code", label: "submit code", enabled: true, visible: true },
    { id: "pause", label: "pause", enabled: true, visible: true },
    { id: "resume", label: "resume", enabled: true, visible: true },
    {
      id: "approve_amendment",
      label: "approve amendment",
      enabled: true,
      visible: workflow.state === "needs_amendment",
    },
    {
      id: "reject_amendment",
      label: "reject amendment",
      enabled: true,
      visible: workflow.state === "needs_amendment",
    },
  ]
  return actions.filter((action): action is WorkflowDetailAction & { visible: true } => action.visible)
}

function short(value: string, length = 12) {
  return value.length > length ? value.slice(0, length) : value
}

function validationLabel(workflow: WorkflowStateFile) {
  if (!workflow.last_validation) return "Validation: -"
  return `Validation: ${workflow.last_validation.ok ? "passed" : "failed"} (${relativeTime(workflow.last_validation.checked_at)})`
}

function scopeLabel(workflow: WorkflowStateFile) {
  if (workflow.state === "needs_amendment") return "Scope: amendment required"
  if (workflow.approved_spec_hash && workflow.approved_plan_commit) return "Scope: approved plan locked"
  if (workflow.approved_spec_hash) return "Scope: spec hash approved"
  return "Scope: awaiting approved plan"
}

function stateColor(state: WorkflowState, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (state) {
    case "executing":
    case "validating":
    case "submitting_plan_pull_request":
    case "submitting_code_pull_request":
    case "awaiting_plan_review":
    case "awaiting_code_review":
      return theme.warning
    case "plan_approved":
      return theme.primary
    case "completed":
      return theme.success
    case "failed":
    case "cancelled":
    case "needs_amendment":
      return theme.error
    case "paused":
      return theme.textMuted
    default:
      return theme.text
  }
}

function reviewColor(state: ReviewState, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (state) {
    case "approved":
    case "merged":
      return theme.success
    case "changes_requested":
      return theme.error
    case "commented":
      return theme.warning
    case "pending":
      return theme.primary
    default:
      return theme.textMuted
  }
}

function stateIcon(state: WorkflowState) {
  switch (state) {
    case "completed":
      return "✓"
    case "failed":
    case "cancelled":
      return "✗"
    case "paused":
      return "⏸"
    case "needs_amendment":
      return "⚠"
    case "executing":
    case "validating":
      return "▶"
    case "submitting_plan_pull_request":
    case "submitting_code_pull_request":
      return "↑"
    case "awaiting_plan_review":
    case "awaiting_code_review":
      return "◷"
    case "addressing_plan_comments":
    case "addressing_code_comments":
      return "↩"
    default:
      return "○"
  }
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function readStateFile(directory: string, workflowID: string): Promise<WorkflowStateFile | null> {
  const statePath = path.join(directory, ".opencode", "workflows", workflowID, "STATE.json")
  const file = Bun.file(statePath)
  if (!(await file.exists())) return null
  return file.json() as Promise<WorkflowStateFile>
}

async function readArtifact(directory: string, workflowID: string, filename: string): Promise<string> {
  const filePath = path.join(directory, ".opencode", "workflows", workflowID, filename)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return ""
  return file.text()
}

async function loadWorkflowList(directory: string): Promise<WorkflowStateFile[]> {
  const root = path.join(directory, ".opencode", "workflows")
  try {
    const entries = (await readdir(root, { withFileTypes: true }).catch(() => [])) as {
      isDirectory: () => boolean
      name: string
    }[]
    const workflowDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("wf_"))
      .map((entry) => entry.name)

    const states = await Promise.all(
      workflowDirs.map(async (id) => {
        const statePath = path.join(root, id, "STATE.json")
        const file = Bun.file(statePath)
        if (!(await file.exists())) return null
        return file.json() as Promise<WorkflowStateFile>
      }),
    )
    return states
      .filter((s): s is WorkflowStateFile => s !== null)
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  } catch {
    return []
  }
}

function WorkflowListView() {
  const project = useProject()
  const route = useRoute()
  const { theme } = useTheme()
  const [workflows, setWorkflows] = createSignal<WorkflowStateFile[]>([])
  const [loading, setLoading] = createSignal(true)

  const refresh = async () => {
    const dir = project.instance.worktree()
    if (!dir) return
    const list = await loadWorkflowList(dir)
    setWorkflows(list)
    setLoading(false)
  }

  onMount(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    onCleanup(() => clearInterval(interval))
  })

  useBindings(() => ({
    commands: [
      {
        name: "workflow.refresh",
        title: "Refresh workflows",
        category: "Workflow",
        run: refresh,
      },
      {
        name: "workflow.open.latest",
        title: "Open latest workflow",
        category: "Workflow",
        run: () => {
          const workflow = workflows()[0]
          if (!workflow) return
          route.navigate({ type: "workflow_detail", workflowID: workflow.workflow_id })
        },
      },
      {
        name: "workflow.open.input_needed",
        title: "Open workflow needing input",
        category: "Workflow",
        run: () => {
          const workflow = workflows().find(workflowNeedsInput)
          if (!workflow) return
          route.navigate({ type: "workflow_detail", workflowID: workflow.workflow_id })
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["bottom"]}
        borderColor={theme.border}
      >
        <text fg={theme.text}>
          <b>Workflows</b>
        </text>
        <text fg={theme.textMuted}> ({workflows().length})</text>
      </box>
      <scrollbox flexGrow={1} flexShrink={1}>
        <Show
          when={!loading()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <Spinner>Loading workflows...</Spinner>
            </box>
          }
        >
          <Show
            when={workflows().length > 0}
            fallback={
              <box paddingLeft={2} paddingTop={1}>
                <text fg={theme.textMuted}>
                  No workflows found. Run `opencode workflow start &lt;title&gt;` to create one.
                </text>
              </box>
            }
          >
            <For each={workflows()}>
              {(wf) => {
                const openComments = () => workflowOpenCommentCount(wf)
                return (
                  <box
                    flexShrink={0}
                    paddingLeft={2}
                    paddingRight={2}
                    paddingTop={1}
                    paddingBottom={1}
                    flexDirection="column"
                    border={["bottom"]}
                    borderColor={theme.border}
                    onMouseUp={() => route.navigate({ type: "workflow_detail", workflowID: wf.workflow_id })}
                  >
                    <box flexDirection="row" gap={2}>
                      <text fg={stateColor(wf.state, theme)}>{stateIcon(wf.state)}</text>
                      <text fg={theme.textMuted}>{short(wf.workflow_id)}</text>
                      <text fg={theme.text}>
                        <b>{wf.title}</b>
                      </text>
                      <text fg={stateColor(wf.state, theme)}>{workflowStateLabel(wf.state)}</text>
                    </box>
                    <box flexDirection="row" gap={2} paddingLeft={2}>
                      <text fg={theme.textMuted}>
                        Phase: <text fg={stateColor(wf.state, theme)}>{workflowStateLabel(wf.state)}</text>
                      </text>
                      <text fg={theme.textMuted}>
                        Plan:{" "}
                        <Show when={wf.plan_pull_request.number} fallback={<text fg={theme.textMuted}>-</text>}>
                          <text fg={reviewColor(wf.plan_pull_request.review_state, theme)}>
                            #{wf.plan_pull_request.number} ({workflowReviewLabel(wf.plan_pull_request.review_state)})
                          </text>
                        </Show>
                      </text>
                      <text fg={theme.textMuted}>
                        Code:{" "}
                        <Show when={wf.code_pull_request.number} fallback={<text fg={theme.textMuted}>-</text>}>
                          <text fg={reviewColor(wf.code_pull_request.review_state, theme)}>
                            #{wf.code_pull_request.number} ({workflowReviewLabel(wf.code_pull_request.review_state)})
                          </text>
                        </Show>
                      </text>
                      <Show when={openComments() > 0}>
                        <text fg={theme.warning}>
                          {openComments()} open comment
                          {openComments() > 1 ? "s" : ""}
                        </text>
                      </Show>
                      <Show when={workflowNeedsInput(wf)}>
                        <text fg={theme.error}>input needed</text>
                      </Show>
                      <Show when={wf.active_session_id}>
                        <text fg={theme.textMuted}>Active: {short(wf.active_session_id!)}</text>
                      </Show>
                      <text fg={theme.textMuted}>Updated: {relativeTime(wf.updated_at)}</text>
                    </box>
                    <Show when={wf.current_task || wf.user_input_needed}>
                      <box flexDirection="row" gap={2} paddingLeft={2}>
                        <Show when={wf.current_task}>
                          <text fg={theme.textMuted}>Task: {wf.current_task}</text>
                        </Show>
                        <Show when={wf.user_input_needed}>
                          <text fg={theme.warning}>Needs: {wf.user_input_needed}</text>
                        </Show>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
          </Show>
        </Show>
      </scrollbox>
    </box>
  )
}

function SpecView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    readArtifact(props.directory, props.workflowID, "SPEC.md").then((text) => {
      setContent(text)
      setLoading(false)
    })
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading spec...</Spinner>}>
        <Show
          when={content()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No SPEC.md found</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="markdown" syntaxStyle={syntax()} content={content()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function TasksView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const progress = createMemo(() => {
    const lines = content().split("\n")
    const total = lines.filter((l) => l.match(/^[-*]\s+\[[ x]\]/i)).length
    const done = lines.filter((l) => l.match(/^[-*]\s+\[x\]/i)).length
    return { done, total }
  })

  onMount(() => {
    readArtifact(props.directory, props.workflowID, "TASKS.md").then((text) => {
      setContent(text)
      setLoading(false)
    })
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading tasks...</Spinner>}>
        <Show when={content()}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
            <text fg={theme.textMuted}>
              Progress: {progress().done}/{progress().total} tasks
              <Show when={progress().total > 0}> ({Math.round((progress().done / progress().total) * 100)}%)</Show>
            </text>
          </box>
        </Show>
        <Show
          when={content()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No TASKS.md found</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="markdown" syntaxStyle={syntax()} content={content()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function ImpactView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    readArtifact(props.directory, props.workflowID, "IMPACT.md").then((text) => {
      setContent(text)
      setLoading(false)
    })
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading impact...</Spinner>}>
        <Show
          when={content()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No IMPACT.md found</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="markdown" syntaxStyle={syntax()} content={content()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function GitHubView(props: { state: WorkflowStateFile }) {
  const { theme } = useTheme()

  const PRCard = (pr: PullRequestState, kind: string) => {
    const display = pr as PullRequestDisplay
    const latestComment = pr.comments
      .map((comment) => comment.updated_at ?? comment.created_at)
      .filter((time): time is string => Boolean(time))
      .toSorted((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    return (
      <box
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        border={["bottom"]}
        borderColor={theme.border}
      >
        <box flexDirection="row" gap={2}>
          <text fg={theme.text}>
            <b>{kind} PR</b>
          </text>
          <Show when={pr.number} fallback={<text fg={theme.textMuted}>Not created</text>}>
            <text fg={theme.primary}>#{pr.number}</text>
            <text fg={reviewColor(pr.review_state, theme)}>({workflowReviewLabel(pr.review_state)})</text>
          </Show>
        </box>
        <Show when={pr.url}>
          <text fg={theme.textMuted}>Link: {pr.url}</text>
        </Show>
        <box flexDirection="row" gap={2}>
          <Show when={pr.branch}>
            <text fg={theme.textMuted}>Branch: {pr.branch}</text>
          </Show>
          <Show when={pr.head_commit}>
            <text fg={theme.textMuted}>Head: {short(pr.head_commit!)}</text>
          </Show>
          <Show when={display.latest_review_at}>
            <text fg={theme.textMuted}>Latest review: {relativeTime(display.latest_review_at!)}</text>
          </Show>
        </box>
        <box flexDirection="row" gap={2}>
          <Show when={display.reviewers?.length}>
            <text fg={theme.textMuted}>Reviewers: {display.reviewers!.join(", ")}</text>
          </Show>
          <Show when={latestComment}>
            <text fg={theme.textMuted}>Latest comment: {relativeTime(latestComment!)}</text>
          </Show>
          <Show when={pr.comments.length > 0}>
            <text fg={theme.textMuted}>
              Comments: {pr.comments.length} ({pr.comments.filter((c) => c.state === "open").length} open)
            </text>
          </Show>
        </box>
      </box>
    )
  }

  return (
    <scrollbox flexGrow={1}>
      <box flexDirection="column">
        {PRCard(props.state.plan_pull_request, "Plan")}
        {PRCard(props.state.code_pull_request, "Code")}
        <Show when={props.state.plan_pull_request.comments.length + props.state.code_pull_request.comments.length > 0}>
          <box paddingLeft={2} paddingTop={1} flexShrink={0}>
            <text fg={theme.text}>
              <b>Comments</b>
            </text>
          </box>
          <For each={[...props.state.plan_pull_request.comments, ...props.state.code_pull_request.comments]}>
            {(comment) => (
              <box
                flexShrink={0}
                paddingLeft={3}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                border={["bottom"]}
                borderColor={theme.border}
                flexDirection="column"
              >
                <box flexDirection="row" gap={2}>
                  <text fg={comment.state === "open" ? theme.warning : theme.textMuted}>[{comment.state}]</text>
                  <Show when={comment.author}>
                    <text fg={theme.primary}>{comment.author}</text>
                  </Show>
                  <text fg={theme.textMuted}>{comment.source}</text>
                  <Show when={comment.path}>
                    <text fg={theme.textMuted}>{comment.path}</text>
                  </Show>
                  <Show when={comment.url}>
                    <text fg={theme.textMuted}>{comment.url}</text>
                  </Show>
                  <Show when={comment.updated_at ?? comment.created_at}>
                    <text fg={theme.textMuted}>{relativeTime((comment.updated_at ?? comment.created_at)!)}</text>
                  </Show>
                </box>
                <box paddingLeft={2} paddingTop={1}>
                  <text fg={theme.text}>{comment.body.slice(0, 200)}</text>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </scrollbox>
  )
}

function SessionsView(props: { state: WorkflowStateFile; onOpen: (sessionID: string) => void }) {
  const { theme } = useTheme()

  return (
    <scrollbox flexGrow={1}>
      <Show
        when={props.state.sessions.length > 0}
        fallback={
          <box paddingLeft={2} paddingTop={1}>
            <text fg={theme.textMuted}>No sessions yet</text>
          </box>
        }
      >
        <For each={props.state.sessions}>
          {(session) => {
            const display = session as WorkflowSessionDisplay
            return (
              <box
                flexShrink={0}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                flexDirection="column"
                border={["bottom"]}
                borderColor={theme.border}
                onMouseUp={() => props.onOpen(session.id)}
              >
                <box flexDirection="row" gap={2}>
                  <text fg={session.status === "active" ? theme.success : theme.textMuted}>
                    {session.status === "active" ? "●" : session.status === "completed" ? "✓" : "○"}
                  </text>
                  <text fg={theme.textMuted}>{session.role}</text>
                  <text fg={theme.textMuted}>{short(session.id)}</text>
                  <text fg={session.status === "active" ? theme.success : theme.textMuted}>{session.status}</text>
                  <Show when={display.agent}>
                    <text fg={theme.textMuted}>Agent: {display.agent}</text>
                  </Show>
                  <Show when={display.input_needed}>
                    <text fg={theme.warning}>input needed</text>
                  </Show>
                </box>
                <box paddingLeft={2} flexDirection="row" gap={2}>
                  <text fg={theme.textMuted}>Task: {session.task || "-"}</text>
                </box>
                <box paddingLeft={2} flexDirection="row" gap={2}>
                  <text fg={theme.textMuted}>Created: {relativeTime(session.created_at)}</text>
                  <text fg={theme.textMuted}>Updated: {relativeTime(session.updated_at)}</text>
                  <Show when={session.github_comment_url}>
                    <text fg={theme.textMuted}>Comment: {session.github_comment_url}</text>
                  </Show>
                </box>
                <Show when={display.files_touched?.length}>
                  <box paddingLeft={2}>
                    <text fg={theme.textMuted}>Files: {display.files_touched!.join(", ")}</text>
                  </box>
                </Show>
                <Show when={display.input_needed}>
                  <box paddingLeft={2}>
                    <text fg={theme.warning}>Needs: {display.input_needed}</text>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </scrollbox>
  )
}

function ChangesView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [diff, setDiff] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  const loadDiff = async () => {
    try {
      const state = await readStateFile(props.directory, props.workflowID)
      if (!state) {
        setLoading(false)
        return
      }
      const baseBranch = state.plan_branch
      const result = spawnSync("git", ["diff", baseBranch, "--stat"], {
        cwd: props.directory,
        encoding: "utf-8",
        timeout: 10000,
      })
      if (result.stdout) {
        setDiff(result.stdout)
      }
    } catch {
      // git diff unavailable
    }
    setLoading(false)
  }

  onMount(() => {
    loadDiff()
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading changes...</Spinner>}>
        <Show
          when={diff()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No file changes or git diff unavailable</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="diff" syntaxStyle={syntax()} content={diff()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function DecisionsView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    readArtifact(props.directory, props.workflowID, "DECISIONS.md").then((text) => {
      setContent(text)
      setLoading(false)
    })
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading decisions...</Spinner>}>
        <Show
          when={content()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No DECISIONS.md found</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="markdown" syntaxStyle={syntax()} content={content()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function AmendmentsView(props: { directory: string; workflowID: string }) {
  const { theme, syntax } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    readArtifact(props.directory, props.workflowID, "AMENDMENT.md").then((text) => {
      setContent(text)
      setLoading(false)
    })
  })

  return (
    <scrollbox flexGrow={1}>
      <Show when={!loading()} fallback={<Spinner>Loading amendment...</Spinner>}>
        <Show
          when={content()}
          fallback={
            <box paddingLeft={2} paddingTop={1}>
              <text fg={theme.textMuted}>No AMENDMENT.md found</text>
            </box>
          }
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <code filetype="markdown" syntaxStyle={syntax()} content={content()} fg={theme.text} />
          </box>
        </Show>
      </Show>
    </scrollbox>
  )
}

function WorkflowDetailView(props: { workflowID: string; initialTab?: string }) {
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [state, setState] = createSignal<WorkflowStateFile | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [tab, setTab] = createSignal<WorkflowTab>((props.initialTab as WorkflowTab) || "spec")
  const detailActions = createMemo(() => (state() ? workflowDetailActions(state()!) : []))

  const dir = () => project.instance.worktree()

  const refresh = async () => {
    const d = dir()
    if (!d) return
    const s = await readStateFile(d, props.workflowID)
    setState(s)
    setLoading(false)
  }

  const openSession = (sessionID?: string) => {
    const workflow = state()
    if (!workflow) return
    const next = workflowOpenSessionRoute(workflow, sessionID)
    if (!next) {
      toast.show({ variant: "error", message: "Workflow has no active session to open" })
      return
    }
    route.navigate(next)
  }

  const steerActiveSession = async () => {
    const workflow = state()
    if (!workflow?.active_session_id) {
      toast.show({ variant: "error", message: "Workflow has no active session to steer" })
      return
    }
    const instruction = await DialogPrompt.show(dialog, "Steer workflow session", {
      placeholder: "Add guidance for the active workflow session",
      description: () => (
        <box flexDirection="column">
          <text fg={theme.textMuted}>Workflow: {workflow.title}</text>
          <text fg={theme.textMuted}>Session: {short(workflow.active_session_id!)}</text>
        </box>
      ),
    })
    const input = workflowSteeringInput(workflow, dir(), instruction)
    if (!input) return
    const next = await WorkflowService.steer(input).catch((error) => {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Failed to steer workflow session",
      })
      return undefined
    })
    if (!next) return
    setState(next)
    dialog.clear()
    toast.show({ variant: "success", message: "Workflow steering recorded" })
  }

  const runWorkflowAction = async (
    label: string,
    action: (workflow: WorkflowStateFile) => Promise<WorkflowStateFile>,
  ) => {
    const workflow = state()
    if (!workflow) return
    const next = await action(workflow).catch((error) => {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : `Failed to ${label}`,
      })
      return undefined
    })
    if (!next) return
    setState(next)
    toast.show({ variant: "success", message: `Workflow ${label}` })
  }

  const revisePlan = async () => {
    const workflow = state()
    if (!workflow) return
    const instruction = await DialogPrompt.show(dialog, "Revise workflow plan", {
      placeholder: "Describe the plan revision or leave blank to use open GitHub comments",
      description: () => <text fg={theme.textMuted}>Workflow: {workflow.title}</text>,
    })
    await runWorkflowAction("plan revision recorded", (wf) =>
      WorkflowService.revisePlan({
        directory: dir(),
        workflowID: wf.workflow_id,
        instruction: instruction?.trim() || undefined,
      }),
    )
    dialog.clear()
  }

  const processAmendment = async (approve: boolean) => {
    const workflow = state()
    if (!workflow) return
    const reason = await DialogPrompt.show(dialog, approve ? "Approve amendment" : "Reject amendment", {
      placeholder: approve ? "Reason for approving amendment" : "Reason for rejecting amendment",
      description: () => <text fg={theme.textMuted}>Workflow: {workflow.title}</text>,
    })
    await runWorkflowAction(approve ? "amendment approved" : "amendment rejected", (wf) =>
      WorkflowService.processAmendment(workflowAmendmentInput(wf, dir(), approve, reason)),
    )
    dialog.clear()
  }

  onMount(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    onCleanup(() => clearInterval(interval))
  })

  useBindings(() => ({
    commands: [
      {
        name: "workflow.refresh",
        title: "Refresh workflow",
        category: "Workflow",
        run: refresh,
      },
      ...tabs.map((item) => ({
        name: `workflow.tab.${item.id}`,
        title: `Workflow: ${item.label}`,
        category: "Workflow",
        run: () => setTab(item.id),
      })),
      {
        name: "workflow.session.open",
        title: "Open workflow active session",
        category: "Workflow",
        run: () => openSession(),
      },
      {
        name: "workflow.steer",
        title: "Steer workflow active session",
        category: "Workflow",
        run: steerActiveSession,
      },
      {
        name: "workflow.submit_plan",
        title: "Submit workflow plan PR",
        category: "Workflow",
        run: () =>
          runWorkflowAction("plan submitted", (workflow) =>
            WorkflowService.submitPlan({ directory: dir(), workflowID: workflow.workflow_id }),
          ),
      },
      {
        name: "workflow.sync_github",
        title: "Sync workflow GitHub state",
        category: "Workflow",
        run: () =>
          runWorkflowAction("GitHub synced", (workflow) =>
            WorkflowService.syncGithub({ directory: dir(), workflowID: workflow.workflow_id }),
          ),
      },
      {
        name: "workflow.revise_plan",
        title: "Revise workflow plan",
        category: "Workflow",
        run: revisePlan,
      },
      {
        name: "workflow.run",
        title: "Run approved workflow",
        category: "Workflow",
        run: () =>
          runWorkflowAction("run completed", (workflow) =>
            WorkflowService.run({ directory: dir(), workflowID: workflow.workflow_id }),
          ),
      },
      {
        name: "workflow.submit_code",
        title: "Submit workflow code PR",
        category: "Workflow",
        run: () =>
          runWorkflowAction("code submitted", (workflow) =>
            WorkflowService.submitCode({ directory: dir(), workflowID: workflow.workflow_id }),
          ),
      },
      {
        name: "workflow.pause",
        title: "Pause workflow",
        category: "Workflow",
        run: () =>
          runWorkflowAction("paused", (workflow) =>
            WorkflowService.pause(dir(), workflow.workflow_id),
          ),
      },
      {
        name: "workflow.resume",
        title: "Resume workflow",
        category: "Workflow",
        run: () =>
          runWorkflowAction("resumed", (workflow) =>
            WorkflowService.resume(dir(), workflow.workflow_id),
          ),
      },
      {
        name: "workflow.amendment.approve",
        title: "Approve workflow amendment",
        category: "Workflow",
        run: () => processAmendment(true),
      },
      {
        name: "workflow.amendment.reject",
        title: "Reject workflow amendment",
        category: "Workflow",
        run: () => processAmendment(false),
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <Show when={!loading() && state()} fallback={<Spinner>Loading workflow...</Spinner>}>
        <box
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          border={["bottom"]}
          borderColor={theme.border}
        >
          <box flexDirection="row" gap={2}>
            <text fg={stateColor(state()!.state, theme)}>{stateIcon(state()!.state)}</text>
            <text fg={theme.text}>
              <b>{state()!.title}</b>
            </text>
            <text fg={stateColor(state()!.state, theme)}>{workflowStateLabel(state()!.state)}</text>
            <text fg={theme.textMuted}>{state()!.workflow_id.slice(0, 12)}</text>
            <Show when={state()!.current_task}>
              <text fg={theme.textMuted}>│ Task: {state()!.current_task}</text>
            </Show>
            <Show when={workflowNeedsInput(state()!)}>
              <text fg={theme.error}>│ input needed</text>
            </Show>
          </box>
        </box>
        <box
          flexShrink={0}
          paddingLeft={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="row"
          gap={1}
          border={["bottom"]}
          borderColor={theme.border}
        >
          <text fg={theme.textMuted}>Plan PR:</text>
          <Show when={state()!.plan_pull_request.number} fallback={<text fg={theme.textMuted}>-</text>}>
            <text fg={reviewColor(state()!.plan_pull_request.review_state, theme)}>
              #{state()!.plan_pull_request.number} ({workflowReviewLabel(state()!.plan_pull_request.review_state)})
            </text>
          </Show>
          <text fg={theme.textMuted}> Code PR:</text>
          <Show when={state()!.code_pull_request.number} fallback={<text fg={theme.textMuted}>-</text>}>
            <text fg={reviewColor(state()!.code_pull_request.review_state, theme)}>
              #{state()!.code_pull_request.number} ({workflowReviewLabel(state()!.code_pull_request.review_state)})
            </text>
          </Show>
          <Show when={state()!.active_session_id}>
            <text fg={theme.textMuted}> Session: {short(state()!.active_session_id!)}</text>
          </Show>
        </box>
        <box
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
          border={["bottom"]}
          borderColor={theme.border}
        >
          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted}>Updated: {relativeTime(state()!.updated_at)}</text>
            <text fg={theme.textMuted}>{validationLabel(state()!)}</text>
            <text fg={state()!.state === "needs_amendment" ? theme.error : theme.textMuted}>
              {scopeLabel(state()!)}
            </text>
            <Show when={workflowOpenCommentCount(state()!) > 0}>
              <text fg={theme.warning}>{workflowOpenCommentCount(state()!)} open comments</text>
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <Show when={(state()! as WorkflowStateDisplay).spec_version}>
              <text fg={theme.textMuted}>Spec version: {(state()! as WorkflowStateDisplay).spec_version}</text>
            </Show>
            <Show when={state()!.approved_spec_hash}>
              <text fg={theme.textMuted}>Approved spec hash: {short(state()!.approved_spec_hash!)}</text>
            </Show>
            <Show when={state()!.approved_plan_commit}>
              <text fg={theme.textMuted}>Approved plan commit: {short(state()!.approved_plan_commit!)}</text>
            </Show>
            <Show when={state()!.user_input_needed}>
              <text fg={theme.warning}>Needs: {state()!.user_input_needed}</text>
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted}>Actions:</text>
            <text
              fg={
                detailActions().find((action) => action.id === "open_session")?.enabled ? theme.primary : theme.textMuted
              }
              onMouseUp={() => openSession()}
            >
              open session
            </text>
            <text
              fg={detailActions().find((action) => action.id === "steer")?.enabled ? theme.primary : theme.textMuted}
              onMouseUp={() => void steerActiveSession()}
            >
              steer
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("GitHub synced", (workflow) => WorkflowService.syncGithub({ directory: dir(), workflowID: workflow.workflow_id }))}>
              sync
            </text>
            <text fg={theme.primary} onMouseUp={() => void revisePlan()}>
              revise
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("plan submitted", (workflow) => WorkflowService.submitPlan({ directory: dir(), workflowID: workflow.workflow_id }))}>
              submit plan
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("run completed", (workflow) => WorkflowService.run({ directory: dir(), workflowID: workflow.workflow_id }))}>
              run
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("code submitted", (workflow) => WorkflowService.submitCode({ directory: dir(), workflowID: workflow.workflow_id }))}>
              submit code
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("paused", (workflow) => WorkflowService.pause(dir(), workflow.workflow_id))}>
              pause
            </text>
            <text fg={theme.primary} onMouseUp={() => void runWorkflowAction("resumed", (workflow) => WorkflowService.resume(dir(), workflow.workflow_id))}>
              resume
            </text>
            <Show when={detailActions().some((action) => action.id === "approve_amendment")}>
              <text fg={theme.primary} onMouseUp={() => void processAmendment(true)}>
                approve amendment
              </text>
              <text fg={theme.primary} onMouseUp={() => void processAmendment(false)}>
                reject amendment
              </text>
            </Show>
          </box>
        </box>
        <box flexShrink={0} flexDirection="row" border={["bottom"]} borderColor={theme.border}>
          <For each={tabs}>
            {(t) => (
              <box
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                flexShrink={0}
                onMouseUp={() => setTab(t.id)}
              >
                <text fg={tab() === t.id ? theme.primary : theme.textMuted}>
                  {tab() === t.id ? <b>[{t.label}]</b> : t.label}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={tab() === "spec"}>
              <SpecView directory={dir()} workflowID={props.workflowID} />
            </Match>
            <Match when={tab() === "tasks"}>
              <TasksView directory={dir()} workflowID={props.workflowID} />
            </Match>
            <Match when={tab() === "impact"}>
              <ImpactView directory={dir()} workflowID={props.workflowID} />
            </Match>
            <Match when={tab() === "github"}>
              <GitHubView state={state()!} />
            </Match>
            <Match when={tab() === "sessions"}>
              <SessionsView state={state()!} onOpen={openSession} />
            </Match>
            <Match when={tab() === "changes"}>
              <ChangesView directory={dir()} workflowID={props.workflowID} />
            </Match>
            <Match when={tab() === "decisions"}>
              <DecisionsView directory={dir()} workflowID={props.workflowID} />
            </Match>
            <Match when={tab() === "amendments"}>
              <AmendmentsView directory={dir()} workflowID={props.workflowID} />
            </Match>
          </Switch>
        </box>
      </Show>
    </box>
  )
}

export function Workflow() {
  const route = useRoute()

  return (
    <Switch>
      <Match when={route.data.type === "workflow"}>
        <WorkflowListView />
      </Match>
      <Match when={route.data.type === "workflow_detail"}>
        <WorkflowDetailView
          workflowID={(route.data as { workflowID: string }).workflowID}
          initialTab={(route.data as { tab?: string }).tab}
        />
      </Match>
    </Switch>
  )
}
