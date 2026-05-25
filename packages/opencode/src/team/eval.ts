import { Database } from "@/storage/db"
import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import {
  TeamTable,
  TeamMemberTable,
  TeamTaskTable,
  TeamMessageTable,
  TeamMessageRecipientTable,
  TeamUsageEventTable,
} from "./team.sql"

export type TeamEvalNodeType = "team" | "member" | "task" | "message" | "session_step" | "tool_call" | "result"

export type TeamEvalEdgeType =
  | "lead_to_member"
  | "depends_on"
  | "message_to"
  | "produces"
  | "contains"
  | "session_event"
  | "propagates_to"

export type TeamEvalFindingSeverity = "info" | "warning" | "error"

export type TeamEvalFindingCategory =
  | "planning.goal_or_decomposition"
  | "planning.missing_or_wrong_dependency"
  | "execution.unknown_agent"
  | "execution.cancelled_member"
  | "execution.empty_result"
  | "execution.stuck_or_blocked"
  | "messaging.pending_delivery"
  | "messaging.missing_progress"
  | "integration.context_loss"
  | "integration.premature_shutdown"
  | "structure.unexpected_or_missing_edge"
  | "shallow_usage"
  | "missing_task_list"
  | "missing_final_report"

export type TeamEvalNode = {
  id: string
  type: TeamEvalNodeType
  ref: string
  label?: string
  status?: string
  time_created: number
  time_updated?: number
  metadata?: Record<string, unknown>
}

export type TeamEvalEdge = {
  id: string
  type: TeamEvalEdgeType
  from: string
  to: string
  metadata?: Record<string, unknown>
}

export type TeamEvalFinding = {
  id: string
  severity: TeamEvalFindingSeverity
  category: TeamEvalFindingCategory
  node_id: string
  message: string
  time_created: number
  root_cause: boolean
  propagated_from?: string
  metadata?: Record<string, unknown>
}

export type TeamUsageMetrics = {
  work_item_count: number
  task_count: number
  member_count: number
  dependency_count: number
  plan_mode_member_count: number
  plan_approval_count: number
  broadcast_count: number
  final_report_generated: boolean
  shallow_usage: boolean
}

type UsageMetricMember = { dependency_ids: string[] | null; plan_mode: boolean }
type UsageMetricTask = { dependency_ids: string[] | null }
type UsageMetricEvent = { type: string }

export type TeamEvalReport = {
  team_id: string
  generated_at: number
  nodes: TeamEvalNode[]
  edges: TeamEvalEdge[]
  findings: TeamEvalFinding[]
  summary: {
    node_count: number
    edge_count: number
    root_cause_count: number
    propagated_failure_count: number
    structural_deviation_count: number
    longest_dependency_chain: number
    usage: TeamUsageMetrics
  }
}

export type TeamEvalExpectedEdge = Pick<TeamEvalEdge, "type" | "from" | "to">

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TeamEval.NotFoundError", {
  teamID: Schema.String,
}) {}

type TeamRow = typeof TeamTable.$inferSelect
type MemberRow = typeof TeamMemberTable.$inferSelect
type TaskRow = typeof TeamTaskTable.$inferSelect
type MessageRow = typeof TeamMessageTable.$inferSelect
type MessageRecipientRow = typeof TeamMessageRecipientTable.$inferSelect
type UsageEventRow = typeof TeamUsageEventTable.$inferSelect
type RawFinding = Omit<TeamEvalFinding, "root_cause" | "propagated_from">

export const build = Effect.fn("TeamEval.build")(function* (
  teamID: string,
  options?: { expectedEdges?: TeamEvalExpectedEdge[] },
) {
  const rows = Database.use(() => {
    const db = Database.Client()
    return {
      team: db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get(),
      members: db.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, teamID)).all(),
      tasks: db.select().from(TeamTaskTable).where(eq(TeamTaskTable.team_id, teamID)).all(),
      messages: db.select().from(TeamMessageTable).where(eq(TeamMessageTable.team_id, teamID)).all(),
      recipients: db
        .select()
        .from(TeamMessageRecipientTable)
        .where(eq(TeamMessageRecipientTable.team_id, teamID))
        .all(),
      usageEvents: db.select().from(TeamUsageEventTable).where(eq(TeamUsageEventTable.team_id, teamID)).all(),
    }
  })

  if (!rows.team) return yield* new NotFoundError({ teamID })

  return reportFromRows(
    rows.team,
    sortRows(rows.members),
    sortRows(rows.tasks),
    sortRows(rows.messages),
    sortRows(rows.recipients),
    sortRows(rows.usageEvents),
    Date.now(),
    options?.expectedEdges ?? [],
  )
})

function reportFromRows(
  team: TeamRow,
  members: MemberRow[],
  tasks: TaskRow[],
  messages: MessageRow[],
  recipients: MessageRecipientRow[],
  usageEvents: UsageEventRow[],
  generatedAt: number,
  expectedEdges: TeamEvalExpectedEdge[],
): TeamEvalReport {
  const teamNodeID = nodeID("team", team.id)
  const memberBySession = new Map(members.map((member) => [member.session_id, member]))
  const taskByID = new Map(tasks.map((task) => [task.id, task]))
  const recipientsByMessage = Map.groupBy(recipients, (recipient) => recipient.message_id)
  const nodeBySession = new Map([
    [team.lead_session_id, teamNodeID],
    ...members.map((member) => [member.session_id, nodeID("member", member.session_id)] as const),
  ])
  const resultMembers = members.filter((member) => hasResult(member))
  const nodes: TeamEvalNode[] = [
    {
      id: teamNodeID,
      type: "team",
      ref: team.id,
      label: team.name,
      status: team.status,
      time_created: team.time_created,
      time_updated: team.time_updated,
      metadata: { goal: team.goal, lead_session_id: team.lead_session_id },
    },
    ...members.map((member) => ({
      id: nodeID("member", member.session_id),
      type: "member" as const,
      ref: member.session_id,
      label: member.name,
      status: member.status,
      time_created: member.time_created,
      time_updated: member.time_updated,
      metadata: {
        member_id: member.id,
        agent_type: member.agent_type,
        model: member.model,
        plan_mode: member.plan_mode,
        work_mode: member.work_mode,
        dependency_ids: member.dependency_ids ?? [],
      },
    })),
    ...tasks.map((task) => ({
      id: nodeID("task", task.id),
      type: "task" as const,
      ref: task.id,
      label: task.description,
      status: task.status,
      time_created: task.time_created,
      time_updated: task.time_updated,
      metadata: {
        assignee: task.assignee,
        dependency_ids: task.dependency_ids ?? [],
        metadata: task.metadata,
      },
    })),
    ...messages.map((message) => ({
      id: nodeID("message", message.id),
      type: "message" as const,
      ref: message.id,
      status: message.delivery_status,
      time_created: message.time_created,
      time_updated: message.time_updated,
      metadata: {
        sender: message.sender,
        recipients: message.recipients,
        body: message.body,
        recipient_statuses: (recipientsByMessage.get(message.id) ?? []).map((recipient) => ({
          recipient: recipient.recipient,
          delivery_status: recipient.delivery_status,
          time_updated: recipient.time_updated,
        })),
      },
    })),
    ...resultMembers.map((member) => ({
      id: nodeID("result", member.session_id),
      type: "result" as const,
      ref: member.session_id,
      label: `${member.name} result`,
      status: "completed",
      time_created: member.time_updated,
      metadata: { member_id: member.id, session_id: member.session_id, result: member.result },
    })),
  ]
  const edges = uniqueEdges([
    ...members.flatMap((member) => [
      edge("contains", teamNodeID, nodeID("member", member.session_id)),
      edge("lead_to_member", teamNodeID, nodeID("member", member.session_id)),
    ]),
    ...tasks.map((task) => edge("contains", teamNodeID, nodeID("task", task.id))),
    ...messages.map((message) => edge("contains", teamNodeID, nodeID("message", message.id))),
    ...members.flatMap((member) =>
      (member.dependency_ids ?? []).flatMap((dependencyID) => {
        const dependency = memberBySession.get(dependencyID)
        if (!dependency) return []
        return [
          edge("depends_on", nodeID("member", dependency.session_id), nodeID("member", member.session_id), {
            dependency_id: dependencyID,
          }),
        ]
      }),
    ),
    ...tasks.flatMap((task) =>
      (task.dependency_ids ?? []).flatMap((dependencyID) => {
        const dependency = taskByID.get(dependencyID)
        if (!dependency) return []
        return [
          edge("depends_on", nodeID("task", dependency.id), nodeID("task", task.id), { dependency_id: dependencyID }),
        ]
      }),
    ),
    ...messages.flatMap((message) =>
      messageRecipients(message, recipientsByMessage.get(message.id) ?? []).flatMap((recipient) => {
        const sender = nodeBySession.get(message.sender)
        const receiver = nodeBySession.get(recipient.recipient)
        if (!sender || !receiver) return []
        return [
          edge("message_to", sender, receiver, {
            message_id: message.id,
            sender: message.sender,
            recipient: recipient.recipient,
            delivery_status: recipient.delivery_status,
          }),
        ]
      }),
    ),
    ...resultMembers.map((member) =>
      edge("produces", nodeID("member", member.session_id), nodeID("result", member.session_id)),
    ),
  ])
  const structuralDeviation = structuralDeviationCount(edges, expectedEdges)
  const usage = usageMetrics(members, tasks, usageEvents)
  const rawFindings = deterministicFindings(team, members, tasks, messages, recipients, structuralDeviation, usage)
  const attributed = attributeFindings(rawFindings, nodes, edges)
  const allEdges = [...edges, ...attributed.edges]

  return {
    team_id: team.id,
    generated_at: generatedAt,
    nodes,
    edges: allEdges,
    findings: attributed.findings,
    summary: {
      node_count: nodes.length,
      edge_count: allEdges.length,
      root_cause_count: attributed.findings.filter((finding) => finding.root_cause).length,
      propagated_failure_count: attributed.findings.filter((finding) => finding.propagated_from !== undefined).length,
      structural_deviation_count: structuralDeviation,
      longest_dependency_chain: longestDependencyChain(edges),
      usage,
    },
  }
}

export function usageMetrics(
  members: UsageMetricMember[],
  tasks: UsageMetricTask[],
  usageEvents: UsageMetricEvent[],
): TeamUsageMetrics {
  const dependencyCount =
    members.filter((member) => (member.dependency_ids ?? []).length > 0).length +
    tasks.filter((task) => (task.dependency_ids ?? []).length > 0).length
  const planApprovalCount = usageEvents.filter((event) => event.type === "plan_approved").length
  const finalReportGenerated = usageEvents.some((event) => event.type === "report_generated")
  return {
    work_item_count: Math.max(tasks.length, members.length),
    task_count: tasks.length,
    member_count: members.length,
    dependency_count: dependencyCount,
    plan_mode_member_count: members.filter((member) => member.plan_mode).length,
    plan_approval_count: planApprovalCount,
    broadcast_count: usageEvents.filter((event) => event.type === "broadcast_sent").length,
    final_report_generated: finalReportGenerated,
    shallow_usage:
      members.length > 0 && tasks.length === 0 && dependencyCount === 0 && planApprovalCount === 0 && !finalReportGenerated,
  }
}

function deterministicFindings(
  team: TeamRow,
  members: MemberRow[],
  tasks: TaskRow[],
  messages: MessageRow[],
  recipients: MessageRecipientRow[],
  structuralDeviation: number,
  usage: TeamUsageMetrics,
) {
  const memberBySession = new Map(members.map((member) => [member.session_id, member]))
  const taskByID = new Map(tasks.map((task) => [task.id, task]))
  const messageByID = new Map(messages.map((message) => [message.id, message]))
  const activeMembers = members.filter((member) => ["active", "starting", "blocked"].includes(member.status))
  return [
    ...members.flatMap((member) => {
      const dependencyIDs = member.dependency_ids ?? []
      const missingDependencies = dependencyIDs.filter((dependencyID) => !memberBySession.has(dependencyID))
      const cancelledDependencies = dependencyIDs.filter(
        (dependencyID) => memberBySession.get(dependencyID)?.status === "cancelled",
      )
      const dependenciesCompleted = dependencyIDs.every(
        (dependencyID) => memberBySession.get(dependencyID)?.status === "completed",
      )
      return [
        member.status === "cancelled"
          ? finding("execution.cancelled_member", "error", nodeID("member", member.session_id), member.time_updated, {
              message: `Member ${member.name} was cancelled.`,
              suffix: "cancelled",
              metadata: { session_id: member.session_id, member_id: member.id },
            })
          : undefined,
        member.status === "blocked" && dependenciesCompleted
          ? finding("execution.stuck_or_blocked", "warning", nodeID("member", member.session_id), member.time_updated, {
              message: `Member ${member.name} is blocked even though all dependencies are completed.`,
              suffix: "blocked",
              metadata: { session_id: member.session_id, dependency_ids: dependencyIDs },
            })
          : undefined,
        member.status === "blocked" && cancelledDependencies.length > 0
          ? finding("execution.stuck_or_blocked", "warning", nodeID("member", member.session_id), member.time_updated, {
              message: `Member ${member.name} is blocked by cancelled dependencies.`,
              suffix: "blocked-by-cancelled-dependency",
              metadata: {
                session_id: member.session_id,
                dependency_ids: dependencyIDs,
                cancelled_dependencies: cancelledDependencies,
              },
            })
          : undefined,
        member.status === "completed" && !hasResult(member)
          ? finding("execution.empty_result", "warning", nodeID("member", member.session_id), member.time_updated, {
              message: `Member ${member.name} completed without a result.`,
              suffix: "empty-result",
              metadata: { session_id: member.session_id, member_id: member.id },
            })
          : undefined,
        ...missingDependencies.map((dependencyID) =>
          finding(
            "planning.missing_or_wrong_dependency",
            "error",
            nodeID("member", member.session_id),
            member.time_created,
            {
              message: `Member ${member.name} depends on missing session ${dependencyID}.`,
              suffix: `missing-member-dependency:${dependencyID}`,
              metadata: { session_id: member.session_id, dependency_id: dependencyID },
            },
          ),
        ),
      ].filter(isDefined)
    }),
    ...tasks.flatMap((task) =>
      (task.dependency_ids ?? [])
        .filter((dependencyID) => !taskByID.has(dependencyID))
        .map((dependencyID) =>
          finding("planning.missing_or_wrong_dependency", "error", nodeID("task", task.id), task.time_created, {
            message: `Task ${task.id} depends on missing task ${dependencyID}.`,
            suffix: `missing-task-dependency:${dependencyID}`,
            metadata: { task_id: task.id, dependency_id: dependencyID },
          }),
        ),
    ),
    team.status === "closed" && activeMembers.length > 0
      ? finding("integration.premature_shutdown", "error", nodeID("team", team.id), team.time_updated, {
          message: `Team closed with ${activeMembers.length} active, starting, or blocked member(s).`,
          suffix: "premature-shutdown",
          metadata: { member_session_ids: activeMembers.map((member) => member.session_id) },
        })
      : undefined,
    ...(team.status === "closed"
      ? recipients
          .filter((recipient) => recipient.delivery_status === "pending")
          .map((recipient) =>
            finding(
              "messaging.pending_delivery",
              "warning",
              nodeID("message", recipient.message_id),
              recipient.time_updated,
              {
                message: `Message ${recipient.message_id} still has pending delivery to ${recipient.recipient}.`,
                suffix: `pending-recipient:${recipient.id}`,
                metadata: {
                  message_id: recipient.message_id,
                  recipient: recipient.recipient,
                  sender: messageByID.get(recipient.message_id)?.sender,
                },
              },
            ),
          )
      : []),
    structuralDeviation > 0
      ? finding("structure.unexpected_or_missing_edge", "info", nodeID("team", team.id), team.time_updated, {
          message: `Evaluation graph differs from expected fixture by ${structuralDeviation} edge(s).`,
          suffix: "structural-deviation",
          metadata: { structural_deviation_count: structuralDeviation },
        })
      : undefined,
    usage.shallow_usage
      ? finding("shallow_usage", "warning", nodeID("team", team.id), team.time_updated, {
          message: "Team used teammates without shared tasks, dependencies, plan approvals, or a final report.",
          suffix: "shallow-usage",
          metadata: usage,
        })
      : undefined,
    usage.work_item_count >= 3 && usage.task_count === 0
      ? finding("missing_task_list", "warning", nodeID("team", team.id), team.time_updated, {
          message: `Team has ${usage.work_item_count} work item(s) but no shared tasks.`,
          suffix: "missing-task-list",
          metadata: usage,
        })
      : undefined,
    isCompletedTeam(team, members) && usage.work_item_count >= 3 && !usage.final_report_generated
      ? finding("missing_final_report", "warning", nodeID("team", team.id), team.time_updated, {
          message: "Non-trivial completed team has no final team_report event.",
          suffix: "missing-final-report",
          metadata: usage,
        })
      : undefined,
  ].filter(isDefined)
}

function attributeFindings(
  rawFindings: RawFinding[],
  _nodes: TeamEvalNode[],
  edges: TeamEvalEdge[],
): { findings: TeamEvalFinding[]; edges: TeamEvalEdge[] } {
  const failureByNode = new Map<string, { severity: TeamEvalFindingSeverity; time_created: number }>()
  for (const finding of rawFindings.filter((item) => item.severity !== "info")) {
    const current = failureByNode.get(finding.node_id)
    const candidate = { severity: finding.severity, time_created: finding.time_created }
    if (!current || compareFailure(candidate, current) < 0) failureByNode.set(finding.node_id, candidate)
  }
  const parentsByNode = Map.groupBy(
    edges.filter((edge) => edge.type === "depends_on"),
    (edge) => edge.to,
  )
  const propagationEdges = new Map<string, TeamEvalEdge>()
  const findings: TeamEvalFinding[] = rawFindings.map((finding) => {
    if (finding.severity === "info") return { ...finding, root_cause: false }
    const selectedParent = (parentsByNode.get(finding.node_id) ?? [])
      .map((edge) => ({ id: edge.from, failure: failureByNode.get(edge.from) }))
      .filter(
        (parent): parent is { id: string; failure: { severity: TeamEvalFindingSeverity; time_created: number } } =>
          parent.failure !== undefined,
      )
      .sort((a, b) => compareFailure(a.failure, b.failure) || a.id.localeCompare(b.id))[0]
    if (!selectedParent) return { ...finding, root_cause: true }
    const propagation = edge("propagates_to", selectedParent.id, finding.node_id, { finding_id: finding.id })
    propagationEdges.set(propagation.id, propagation)
    return { ...finding, root_cause: false, propagated_from: selectedParent.id }
  })
  return { findings, edges: Array.from(propagationEdges.values()) }
}

function compareFailure(
  a: { severity: TeamEvalFindingSeverity; time_created: number },
  b: { severity: TeamEvalFindingSeverity; time_created: number },
) {
  return severityRank(b.severity) - severityRank(a.severity) || a.time_created - b.time_created
}

function severityRank(severity: TeamEvalFindingSeverity) {
  if (severity === "error") return 2
  if (severity === "warning") return 1
  return 0
}

function structuralDeviationCount(edges: TeamEvalEdge[], expectedEdges: TeamEvalExpectedEdge[]) {
  if (expectedEdges.length === 0) return 0
  const expectedTypes = new Set(expectedEdges.map((item) => item.type))
  const actualKeys = new Set(edges.filter((item) => expectedTypes.has(item.type)).map(edgeKey))
  const expectedKeys = new Set(expectedEdges.map(edgeKey))
  return (
    expectedEdges.filter((item) => !actualKeys.has(edgeKey(item))).length +
    edges.filter((item) => expectedTypes.has(item.type) && !expectedKeys.has(edgeKey(item))).length
  )
}

function longestDependencyChain(edges: TeamEvalEdge[]) {
  const childrenByParent = Map.groupBy(
    edges.filter((edge) => edge.type === "depends_on"),
    (edge) => edge.from,
  )
  const depth = (node: string, path: Set<string>): number => {
    if (path.has(node)) return 0
    const nextPath = new Set(path).add(node)
    return (childrenByParent.get(node) ?? []).reduce((max, child) => Math.max(max, 1 + depth(child.to, nextPath)), 0)
  }
  return Array.from(childrenByParent.keys()).reduce((max, node) => Math.max(max, depth(node, new Set())), 0)
}

function messageRecipients(message: MessageRow, recipients: MessageRecipientRow[]) {
  if (recipients.length > 0) return recipients
  return message.recipients.map((recipient) => ({
    id: `${message.id}:${recipient}`,
    message_id: message.id,
    team_id: message.team_id,
    recipient,
    delivery_status: message.delivery_status,
    time_created: message.time_created,
    time_updated: message.time_updated,
  }))
}

function sortRows<T extends { id: string; time_created: number }>(rows: T[]) {
  return [...rows].sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
}

function hasResult(member: MemberRow) {
  return member.result !== null && member.result.trim().length > 0
}

function isCompletedTeam(team: TeamRow, members: MemberRow[]) {
  if (team.status !== "closed") return false
  return members.every((member) => !["active", "starting", "blocked"].includes(member.status))
}

function finding(
  category: TeamEvalFindingCategory,
  severity: TeamEvalFindingSeverity,
  nodeID: string,
  timeCreated: number,
  input: { message: string; suffix: string; metadata?: Record<string, unknown> },
): RawFinding {
  return {
    id: `finding:${category}:${nodeID}:${input.suffix}`,
    severity,
    category,
    node_id: nodeID,
    message: input.message,
    time_created: timeCreated,
    metadata: input.metadata,
  }
}

function edge(type: TeamEvalEdgeType, from: string, to: string, metadata?: Record<string, unknown>): TeamEvalEdge {
  return { id: `edge:${type}:${from}->${to}`, type, from, to, metadata }
}

function uniqueEdges(edges: TeamEvalEdge[]) {
  return Array.from(new Map(edges.map((item) => [item.id, item])).values())
}

function edgeKey(edge: TeamEvalExpectedEdge) {
  return `${edge.type}\u0000${edge.from}\u0000${edge.to}`
}

function nodeID(type: TeamEvalNodeType, id: string) {
  return `${type}:${id}`
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

export * as TeamEval from "./eval"
