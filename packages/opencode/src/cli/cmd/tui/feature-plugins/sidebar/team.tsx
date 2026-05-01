import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Spinner } from "../../component/spinner"

const id = "internal:sidebar-team"

function memberStatusDot(
  status: { type: string } | undefined,
  teamStatus: string | undefined,
  theme: TuiPluginApi["theme"]["current"],
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

function statusLabel(status: { type: string } | undefined, teamStatus: string | undefined) {
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

function isMemberWorking(status: { type: string } | undefined, teamStatus: string | undefined) {
  return status?.type === "busy" || teamStatus === "starting" || teamStatus === "active"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const sync = useSync()
  const theme = () => props.api.theme.current
  const teamsEnabled = createMemo(() => props.api.state.config.experimental?.agent_teams === true)
  const members = createMemo(() => (teamsEnabled() ? props.api.state.session.children(props.session_id) : []))

  const pendingPermissions = createMemo(() => {
    if (!teamsEnabled()) return 0
    return members().reduce(
      (count, member) =>
        count +
        props.api.state.session.permission(member.id).length +
        props.api.state.session.question(member.id).length,
      0,
    )
  })

  return (
    <Show when={teamsEnabled()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => members().length > 2 && setOpen((x) => !x)}>
          <Show when={members().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Team</b>
            <Show when={members().length > 0}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({members().length} member{members().length !== 1 ? "s" : ""})
              </span>
            </Show>
            <Show when={pendingPermissions() > 0}>
              <span style={{ fg: theme().warning }}> [{pendingPermissions()} pending]</span>
            </Show>
          </text>
        </box>
        <Show when={!props.api.state.ready}>
          <Spinner color={theme().textMuted}>Loading team members...</Spinner>
        </Show>
        <Show when={props.api.state.ready && members().length === 0}>
          <text fg={theme().textMuted}>No team members. Use team_create then team_spawn to add members.</text>
        </Show>
        <Show when={members().length > 0 && (members().length <= 2 || open())}>
          <For each={members()}>
            {(member) => {
              const [hover, setHover] = createSignal(false)
              const status = createMemo(() => props.api.state.session.status(member.id))
              const teamStatus = createMemo(() => sync.data.team_member_status[member.id])
              const statusColor = createMemo(() => memberStatusDot(status(), teamStatus(), theme()))

              const memberPerms = createMemo(() => {
                const permCount = props.api.state.session.permission(member.id).length
                const questionCount = props.api.state.session.question(member.id).length
                return permCount + questionCount
              })

              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseOver={() => setHover(true)}
                  onMouseOut={() => setHover(false)}
                  onMouseDown={() => {
                    if (member.id !== props.session_id) {
                      props.api.route.navigate("session", { sessionID: member.id })
                    }
                  }}
                  backgroundColor={hover() ? theme().backgroundElement : undefined}
                >
                  <Show
                    when={isMemberWorking(status(), teamStatus())}
                    fallback={
                      <text
                        flexShrink={0}
                        style={{
                          fg: statusColor(),
                        }}
                      >
                        •
                      </text>
                    }
                  >
                    <box flexShrink={0}>
                      <Spinner color={statusColor()} />
                    </box>
                  </Show>
                  <text fg={theme().textMuted}>{member.title}</text>
                  <text fg={theme().textMuted}>({statusLabel(status(), teamStatus())})</text>
                  <Show when={memberPerms() > 0}>
                    <text style={{ fg: theme().warning }}>[{memberPerms()} pending]</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
