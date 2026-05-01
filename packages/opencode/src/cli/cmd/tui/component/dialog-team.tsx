import type { TeamInfo, TeamTask, TeamMessage, Session } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { SplitBorder } from "./border"
import { TextAttributes } from "@opentui/core"

type Tab = "overview" | "tasks" | "messages"

function memberStatusColor(
  status: { type: string } | undefined,
  teamStatus: string | undefined,
  theme: ReturnType<typeof useTheme>["theme"],
) {
  const t = status?.type
  if (t === "retry") return theme.error
  if (t === "busy") return theme.success
  if (teamStatus === "completed") return theme.success
  if (teamStatus === "cancelled") return theme.error
  if (teamStatus === "starting" || teamStatus === "blocked" || teamStatus === "active" || teamStatus === "idle")
    return theme.info
  return theme.textMuted
}

function memberStatusLabel(status: { type: string } | undefined, teamStatus: string | undefined) {
  const t = status?.type
  if (t === "retry") return "retry"
  if (t === "busy") return "working"
  if (teamStatus === "active") return "active"
  if (teamStatus === "starting") return "starting"
  if (teamStatus === "blocked") return "blocked"
  if (teamStatus === "completed") return "completed"
  if (teamStatus === "cancelled") return "cancelled"
  if (teamStatus === "idle") return "idle"
  return "idle"
}

function taskStatusColor(status: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "completed") return theme.success
  if (status === "in_progress") return theme.warning
  if (status === "cancelled") return theme.error
  return theme.textMuted
}

function deliveryStatusColor(status: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "read") return theme.success
  if (status === "delivered") return theme.text
  return theme.warning
}

export function DialogTeam(props: { focusTab?: Tab }) {
  const route = useRouteData("session")
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()

  const session = createMemo(() => sync.session.get(route.sessionID) as Session | undefined)
  const sessionID = createMemo(() => {
    const s = session()
    return s ? (s.parentID ?? s.id) : route.sessionID
  })

  const [team] = createResource(
    () => sessionID(),
    (sid) =>
      sdk.client.team
        .get({ sessionID: sid })
        .then((res) => (res.data ?? undefined) as TeamInfo | undefined)
        .catch(() => undefined),
  )

  const teamID = createMemo(() => team()?.id)
  const teamsEnabled = createMemo(() => sync.data.config.experimental?.agent_teams === true)

  const [tasks] = createResource(
    () => teamID(),
    (id) =>
      sdk.client.team
        .tasks({ teamID: id })
        .then((res) => (res.data ?? []) as TeamTask[])
        .catch(() => [] as TeamTask[]),
  )

  const [messages] = createResource(
    () => teamID(),
    (id) =>
      sdk.client.team
        .messages({ teamID: id })
        .then((res) => (res.data ?? []) as TeamMessage[])
        .catch(() => [] as TeamMessage[]),
  )

  const childSessions = createMemo(() => {
    const sid = sessionID()
    return sync.data.session.filter((x) => x.parentID === sid).toSorted((a, b) => a.id.localeCompare(b.id))
  })

  const children = createMemo(() => {
    const sid = sessionID()
    return sync.data.session
      .filter((x) => x.parentID === sid || x.id === sid)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })

  const permissions = createMemo(() => children().flatMap((x) => sync.data.permission[x.id] ?? []))
  const questions = createMemo(() => children().flatMap((x) => sync.data.question[x.id] ?? []))

  const [tab, setTab] = createSignal<Tab>(props.focusTab ?? "overview")

  const tabStyle = (t: Tab) => ({
    fg: tab() === t ? theme.text : theme.textMuted,
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Team Panel
          <Show when={team()}>{(t) => <span style={{ fg: theme.textMuted }}> · {t().name}</span>}</Show>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show
        when={teamsEnabled()}
        fallback={
          <text fg={theme.warning}>
            Agent teams are disabled. Enable <span style={{ fg: theme.text }}>experimental.agent_teams</span> in config.
          </text>
        }
      >
        <Show
          when={team()}
          fallback={
            <Show when={team.loading}>
              <text fg={theme.textMuted}>Loading team data...</text>
            </Show>
          }
        >
          {(t) => {
            const info = t()
            return (
              <>
                <box flexDirection="row" gap={2} paddingBottom={1}>
                  <box onMouseUp={() => setTab("overview")}>
                    <text style={tabStyle("overview")} attributes={TextAttributes.BOLD}>
                      Overview
                    </text>
                  </box>
                  <box onMouseUp={() => setTab("tasks")}>
                    <text style={tabStyle("tasks")} attributes={TextAttributes.BOLD}>
                      Tasks ({tasks()?.length ?? 0})
                    </text>
                  </box>
                  <box onMouseUp={() => setTab("messages")}>
                    <text style={tabStyle("messages")} attributes={TextAttributes.BOLD}>
                      Messages ({messages()?.length ?? 0})
                    </text>
                  </box>
                </box>

                <Show when={tab() === "overview"}>
                  <box gap={1}>
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.textMuted}>Status:</text>
                      <text
                        fg={
                          info.status === "active"
                            ? theme.success
                            : info.status === "closed"
                              ? theme.error
                              : theme.textMuted
                        }
                      >
                        {info.status}
                      </text>
                    </box>
                    <Show when={info.goal}>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>Goal:</text>
                        <text fg={theme.text}>{info.goal}</text>
                      </box>
                    </Show>

                    <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Members ({childSessions().length})
                      </text>
                    </box>
                    <Show when={childSessions().length === 0}>
                      <text fg={theme.textMuted}>No team members. Use team_spawn to add members.</text>
                    </Show>
                    <For each={childSessions()}>
                      {(member) => {
                        const status = createMemo(() => sync.data.session_status[member.id])
                        const teamStatus = createMemo(() => sync.data.team_member_status[member.id])
                        return (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: memberStatusColor(status(), teamStatus(), theme) }}>
                              •
                            </text>
                            <text fg={theme.text}>{member.title}</text>
                            <text fg={theme.textMuted}>({memberStatusLabel(status(), teamStatus())})</text>
                          </box>
                        )
                      }}
                    </For>

                    <Show when={permissions().length > 0 || questions().length > 0}>
                      <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          Pending ({permissions().length + questions().length})
                        </text>
                      </box>
                      <For each={permissions()}>
                        {(item) => (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: theme.warning }}>
                              !
                            </text>
                            <text fg={theme.text} wrapMode="word">
                              Permission: {item.permission} - {item.patterns?.join(", ") ?? ""}
                            </text>
                          </box>
                        )}
                      </For>
                      <For each={questions()}>
                        {(item) => (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: theme.warning }}>
                              ?
                            </text>
                            <text fg={theme.text} wrapMode="word">
                              Questions: {item.questions?.map((q) => q.question).join(", ") ?? ""}
                            </text>
                          </box>
                        )}
                      </For>
                    </Show>

                    <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                      <box
                        onMouseUp={() => {
                          void sdk.client.team.shutdown({ teamID: info.id }).then(() => dialog.clear())
                        }}
                      >
                        <text fg={theme.error}>Shutdown Team</text>
                      </box>
                    </box>
                  </box>
                </Show>

                <Show when={tab() === "tasks"}>
                  <Show
                    when={(tasks()?.length ?? 0) > 0}
                    fallback={<text fg={theme.textMuted}>No tasks created yet.</text>}
                  >
                    <For each={tasks()!}>
                      {(task) => (
                        <box flexDirection="row" gap={1}>
                          <text flexShrink={0} style={{ fg: taskStatusColor(task.status, theme) }}>
                            {task.status === "completed"
                              ? "✓"
                              : task.status === "in_progress"
                                ? "▶"
                                : task.status === "cancelled"
                                  ? "✗"
                                  : "○"}
                          </text>
                          <text fg={theme.text} wrapMode="word">
                            {task.description}
                          </text>
                          <text fg={theme.textMuted}>{task.status}</text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>

                <Show when={tab() === "messages"}>
                  <Show
                    when={(messages()?.length ?? 0) > 0}
                    fallback={<text fg={theme.textMuted}>No messages exchanged yet.</text>}
                  >
                    <For each={messages()!}>
                      {(msg) => (
                        <box gap={0} paddingBottom={1}>
                          <box flexDirection="row" gap={1}>
                            <text fg={theme.text} attributes={TextAttributes.BOLD}>
                              {msg.sender}
                            </text>
                            <text fg={theme.textMuted}>→ [{msg.recipients.join(", ")}]</text>
                            <text flexShrink={0} style={{ fg: deliveryStatusColor(msg.delivery_status, theme) }}>
                              {msg.delivery_status}
                            </text>
                          </box>
                          <text fg={theme.text} wrapMode="word">
                            {msg.body}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>
              </>
            )
          }}
        </Show>
      </Show>
    </box>
  )
}
