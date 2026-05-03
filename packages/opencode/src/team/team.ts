import { Database } from "@/storage/db"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { eq, and } from "drizzle-orm"
import { TeamTable, TeamMemberTable, TeamTaskTable, TeamMessageTable, TeamMessageRecipientTable } from "./team.sql"

const toOption = <T>(v: T | null | undefined): Option.Option<T> => (v != null ? Option.some(v) : Option.none())

export interface Interface {
  create: (input: { name: string; goal: string; leadSessionID: string }) => Effect.Effect<any>
  getActive: (leadSessionID: string) => Effect.Effect<Option.Option<any>>
  get: (teamID: string) => Effect.Effect<Option.Option<any>>
  shutdown: (teamID: string) => Effect.Effect<void>
  addMember: (input: {
    teamID: string
    sessionID: string
    name: string
    agentType: string
    model?: { providerID: string; modelID: string }
    rolePrompt: string
    planMode?: boolean
    workMode?: string
    dependencyIDs?: string[]
  }) => Effect.Effect<any>
  updateMemberStatus: (memberID: string, status: string, result?: string) => Effect.Effect<Option.Option<any>>
  getMembers: (teamID: string) => Effect.Effect<any[]>
  getMemberBySession: (sessionID: string) => Effect.Effect<Option.Option<any>>
  getContext: (sessionID: string) => Effect.Effect<Option.Option<{ team: any; member?: any }>>
  createTask: (input: {
    teamID: string
    description: string
    assignee?: string
    dependencyIDs?: string[]
    metadata?: Record<string, unknown>
  }) => Effect.Effect<any>
  updateTask: (
    taskID: string,
    update: Partial<{ status: string; assignee: string }>,
  ) => Effect.Effect<Option.Option<any>>
  claimTask: (taskID: string, assignee: string) => Effect.Effect<Option.Option<any>>
  getTasks: (teamID: string) => Effect.Effect<any[]>
  sendMessage: (input: { teamID: string; sender: string; recipients: string[]; body: string }) => Effect.Effect<any>
  getMessages: (teamID: string) => Effect.Effect<any[]>
  getPendingMessages: (recipientSession: string, teamID: string) => Effect.Effect<any[]>
  markMessageDelivered: (messageID: string, recipientSession?: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

const TeamCreated = BusEvent.define("team.created", Schema.Struct({ teamID: Schema.String }))
const TeamClosed = BusEvent.define("team.closed", Schema.Struct({ teamID: Schema.String }))
const MemberUpdated = BusEvent.define(
  "team.member.updated",
  Schema.Struct({ memberID: Schema.String, sessionID: Schema.String, status: Schema.String }),
)
const MessageReceived = BusEvent.define(
  "team.message.received",
  Schema.Struct({ messageID: Schema.String, teamID: Schema.String, sender: Schema.String }),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const runState = yield* SessionRunState.Service
    const db = () => Database.Client()

    const create = Effect.fn("Team.create")(function* (input: { name: string; goal: string; leadSessionID: string }) {
      const existing = Database.use(() =>
        db()
          .select()
          .from(TeamTable)
          .where(and(eq(TeamTable.lead_session_id, input.leadSessionID), eq(TeamTable.status, "active")))
          .get(),
      )
      if (existing) {
        return yield* Effect.die(new Error("Lead session already has an active team"))
      }

      const id = crypto.randomUUID()
      const now = Date.now()
      Database.use(() => {
        const values: any = {
          id,
          name: input.name,
          goal: input.goal,
          lead_session_id: input.leadSessionID,
          status: "active",
          time_created: now,
          time_updated: now,
        }
        db().insert(TeamTable).values(values).run()
      })
      yield* bus.publish(TeamCreated, { teamID: id })
      yield* bus.publish(TuiEvent.ToastShow, {
        title: "Team Created",
        message: `Team "${input.name}" is ready. Add members with team_spawn.`,
        variant: "success",
        duration: 5000,
      })
      return {
        id,
        name: input.name,
        goal: input.goal,
        lead_session_id: input.leadSessionID,
        status: "active",
        time_created: now,
        time_updated: now,
      }
    })

    const getActive = Effect.fn("Team.getActive")(function* (leadSessionID: string) {
      const row = Database.use(() =>
        db()
          .select()
          .from(TeamTable)
          .where(and(eq(TeamTable.lead_session_id, leadSessionID), eq(TeamTable.status, "active")))
          .get(),
      )
      return toOption(row)
    })

    const get = Effect.fn("Team.get")(function* (teamID: string) {
      const row = Database.use(() => db().select().from(TeamTable).where(eq(TeamTable.id, teamID)).get())
      return toOption(row)
    })

    const shutdown = Effect.fn("Team.shutdown")(function* (teamID: string) {
      const now = Date.now()
      Database.transaction(() => {
        db()
          .update(TeamTable)
          .set({ status: "closed", time_updated: now } as any)
          .where(eq(TeamTable.id, teamID))
          .run()
        const members = db()
          .select()
          .from(TeamMemberTable)
          .where(eq(TeamMemberTable.team_id, teamID))
          .all()
        for (const m of members) {
          if (m.status !== "completed" && m.status !== "cancelled") {
            db()
              .update(TeamMemberTable)
              .set({ status: "cancelled", time_updated: now } as any)
              .where(eq(TeamMemberTable.id, m.id))
              .run()
          }
        }
      })
      const allMembers = Database.use(() =>
        db().select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, teamID)).all(),
      )
      yield* Effect.forEach(
        allMembers,
        (member) => runState.cancel(SessionID.make(member.session_id)).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      )
      yield* bus.publish(TeamClosed, { teamID })
      yield* bus.publish(TuiEvent.ToastShow, {
        title: "Team Shut Down",
        message: "The team has been closed and all active members cancelled.",
        variant: "info",
        duration: 5000,
      })
    })

    const addMember = Effect.fn("Team.addMember")(function* (input: {
      teamID: string
      sessionID: string
      name: string
      agentType: string
      model?: { providerID: string; modelID: string }
      rolePrompt: string
      planMode?: boolean
      workMode?: string
      dependencyIDs?: string[]
    }) {
      const id = crypto.randomUUID()
      const now = Date.now()
      Database.use(() => {
        const values: any = {
          id,
          team_id: input.teamID,
          session_id: input.sessionID,
          name: input.name,
          agent_type: input.agentType,
          model: input.model ?? null,
          role_prompt: input.rolePrompt,
          status: "starting",
          plan_mode: input.planMode ?? false,
          work_mode: input.workMode ?? "implement",
          dependency_ids: input.dependencyIDs ?? null,
          result: null,
          time_created: now,
          time_updated: now,
        }
        db().insert(TeamMemberTable).values(values).run()
      })
      return {
        id,
        team_id: input.teamID,
        session_id: input.sessionID,
        name: input.name,
        agent_type: input.agentType,
        model: input.model,
        role_prompt: input.rolePrompt,
        status: "starting",
        plan_mode: input.planMode ?? false,
        work_mode: input.workMode ?? "implement",
        dependency_ids: input.dependencyIDs,
        result: undefined,
        time_created: now,
        time_updated: now,
      }
    })

    const updateMemberStatus = Effect.fn("Team.updateMemberStatus")(function* (
      memberID: string,
      status: string,
      result?: string,
    ) {
      const now = Date.now()
      const setData: Record<string, unknown> = { status, time_updated: now }
      if (result !== undefined) setData.result = result
      Database.use(() =>
        db()
          .update(TeamMemberTable)
          .set(setData as any)
          .where(eq(TeamMemberTable.id, memberID))
          .run(),
      )
      const row = Database.use(() => db().select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get())
      if (!row) return Option.none()
      yield* bus.publish(MemberUpdated, { memberID: row.id, sessionID: row.session_id, status: row.status })

      if (row.status === "completed" || row.status === "idle") {
        const statusText = row.status === "completed" ? "completed their work" : "became idle"
        const team = Database.use(() => db().select().from(TeamTable).where(eq(TeamTable.id, row.team_id)).get())
        if (team) {
          const msgId = crypto.randomUUID()
          const msgNow = Date.now()
          Database.use(() => {
            db()
              .insert(TeamMessageTable)
              .values({
                id: msgId,
                team_id: row.team_id,
                sender: row.session_id,
                recipients: [team.lead_session_id],
                body: `Teammate ${row.name} (${row.agent_type}) has ${statusText}.`,
                delivery_status: "pending",
                time_created: msgNow,
                time_updated: msgNow,
              } as any)
              .run()
          })
          yield* bus.publish(MessageReceived, { messageID: msgId, teamID: row.team_id, sender: row.session_id })
          yield* bus.publish(TuiEvent.ToastShow, {
            title: "Teammate Update",
            message: `${row.name} (${row.agent_type}) has ${statusText}.`,
            variant: "info",
            duration: 5000,
          })
        }
      }

      return Option.some({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const getMembers = Effect.fn("Team.getMembers")(function* (teamID: string) {
      return Database.use(() =>
        db()
          .select()
          .from(TeamMemberTable)
          .where(eq(TeamMemberTable.team_id, teamID))
          .all()
          .map((row) => ({
            id: row.id,
            team_id: row.team_id,
            session_id: row.session_id,
            name: row.name,
            agent_type: row.agent_type,
            model: row.model,
            role_prompt: row.role_prompt,
            status: row.status,
            plan_mode: row.plan_mode,
            work_mode: row.work_mode,
            dependency_ids: row.dependency_ids,
            result: row.result,
            time_created: row.time_created,
            time_updated: row.time_updated,
          })),
      )
    })

    const getMemberBySession = Effect.fn("Team.getMemberBySession")(function* (sessionID: string) {
      const row = Database.use(() =>
        db().select().from(TeamMemberTable).where(eq(TeamMemberTable.session_id, sessionID)).get(),
      )
      if (!row) return Option.none()
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const getContext = Effect.fn("Team.getContext")(function* (sessionID: string) {
      const active = yield* getActive(sessionID)
      if (Option.isSome(active)) return Option.some({ team: active.value })
      const member = yield* getMemberBySession(sessionID)
      if (Option.isNone(member)) return Option.none()
      const info = yield* get(member.value.team_id)
      if (Option.isNone(info) || info.value.status !== "active") return Option.none()
      return Option.some({ team: info.value, member: member.value })
    })

    const createTask = Effect.fn("Team.createTask")(function* (input: {
      teamID: string
      description: string
      assignee?: string
      dependencyIDs?: string[]
      metadata?: Record<string, unknown>
    }) {
      const id = crypto.randomUUID()
      const now = Date.now()
      Database.use(() => {
        const values: any = {
          id,
          team_id: input.teamID,
          description: input.description,
          status: "pending",
          assignee: input.assignee ?? null,
          dependency_ids: input.dependencyIDs ?? null,
          metadata: input.metadata ?? null,
          time_created: now,
          time_updated: now,
        }
        db().insert(TeamTaskTable).values(values).run()
      })
      return {
        id,
        team_id: input.teamID,
        description: input.description,
        status: "pending",
        assignee: input.assignee,
        dependency_ids: input.dependencyIDs,
        metadata: input.metadata,
        time_created: now,
        time_updated: now,
      }
    })

    const updateTask = Effect.fn("Team.updateTask")(function* (
      taskID: string,
      update: Partial<{ status: string; assignee: string }>,
    ) {
      const now = Date.now()
      const setData: Record<string, unknown> = { time_updated: now }
      if (update.status !== undefined) setData.status = update.status
      if (update.assignee !== undefined) setData.assignee = update.assignee
      Database.use(() =>
        db()
          .update(TeamTaskTable)
          .set(setData as any)
          .where(eq(TeamTaskTable.id, taskID))
          .run(),
      )
      const row = Database.use(() => db().select().from(TeamTaskTable).where(eq(TeamTaskTable.id, taskID)).get())
      if (!row) return Option.none()
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        dependency_ids: row.dependency_ids,
        metadata: row.metadata,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const claimTask = Effect.fn("Team.claimTask")(function* (taskID: string, assignee: string) {
      const now = Date.now()
      const result = Database.transaction(() => {
        const current = db().select().from(TeamTaskTable).where(eq(TeamTaskTable.id, taskID)).get()
        if (!current || current.status !== "pending") return null
        if (current.dependency_ids) {
          const deps = current.dependency_ids as string[]
          const incomplete = db()
            .select()
            .from(TeamTaskTable)
            .where(eq(TeamTaskTable.team_id, current.team_id))
            .all()
            .filter((t) => deps.includes(t.id) && t.status !== "completed" && t.status !== "cancelled")
          if (incomplete.length > 0) return null
        }
        db()
          .update(TeamTaskTable)
          .set({ status: "in_progress", assignee, time_updated: now } as any)
          .where(eq(TeamTaskTable.id, taskID))
          .run()
        return db().select().from(TeamTaskTable).where(eq(TeamTaskTable.id, taskID)).get()
      })
      if (!result) return Option.none()
      return Option.some({
        id: result.id,
        team_id: result.team_id,
        description: result.description,
        status: result.status,
        assignee: result.assignee,
        dependency_ids: result.dependency_ids,
        metadata: result.metadata,
        time_created: result.time_created,
        time_updated: result.time_updated,
      })
    })

    const getTasks = Effect.fn("Team.getTasks")(function* (teamID: string) {
      return Database.use(() =>
        db()
          .select()
          .from(TeamTaskTable)
          .where(eq(TeamTaskTable.team_id, teamID))
          .all()
          .map((row) => ({
            id: row.id,
            team_id: row.team_id,
            description: row.description,
            status: row.status,
            assignee: row.assignee,
            dependency_ids: row.dependency_ids,
            metadata: row.metadata,
            time_created: row.time_created,
            time_updated: row.time_updated,
          })),
      )
    })

    const sendMessage = Effect.fn("Team.sendMessage")(function* (input: {
      teamID: string
      sender: string
      recipients: string[]
      body: string
    }) {
      const id = crypto.randomUUID()
      const now = Date.now()
      const recipients = [...new Set(input.recipients)]
      Database.transaction(() => {
        const values: any = {
          id,
          team_id: input.teamID,
          sender: input.sender,
          recipients,
          body: input.body,
          delivery_status: "pending",
          time_created: now,
          time_updated: now,
        }
        db().insert(TeamMessageTable).values(values).run()
        for (const recipient of recipients) {
          db()
            .insert(TeamMessageRecipientTable)
            .values({
              id: crypto.randomUUID(),
              message_id: id,
              team_id: input.teamID,
              recipient,
              delivery_status: "pending",
              time_created: now,
              time_updated: now,
            } as any)
            .run()
        }
      })
      yield* bus.publish(MessageReceived, { messageID: id, teamID: input.teamID, sender: input.sender })
      return {
        id,
        team_id: input.teamID,
        sender: input.sender,
        recipients,
        body: input.body,
        delivery_status: "pending",
        time_created: now,
        time_updated: now,
      }
    })

    const getMessages = Effect.fn("Team.getMessages")(function* (teamID: string) {
      return Database.use(() =>
        db()
          .select()
          .from(TeamMessageTable)
          .where(eq(TeamMessageTable.team_id, teamID))
          .all()
          .map((row) => ({
            id: row.id,
            team_id: row.team_id,
            sender: row.sender,
            recipients: row.recipients,
            body: row.body,
            delivery_status: row.delivery_status,
            time_created: row.time_created,
            time_updated: row.time_updated,
          })),
      )
    })

    const getPendingMessages = Effect.fn("Team.getPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      const rows = Database.use(() =>
        db()
          .select({
            id: TeamMessageTable.id,
            team_id: TeamMessageTable.team_id,
            sender: TeamMessageTable.sender,
            recipients: TeamMessageTable.recipients,
            body: TeamMessageTable.body,
            delivery_status: TeamMessageRecipientTable.delivery_status,
            time_created: TeamMessageTable.time_created,
            time_updated: TeamMessageTable.time_updated,
          })
          .from(TeamMessageTable)
          .innerJoin(TeamMessageRecipientTable, eq(TeamMessageRecipientTable.message_id, TeamMessageTable.id))
          .where(
            and(
              eq(TeamMessageRecipientTable.team_id, teamID),
              eq(TeamMessageRecipientTable.recipient, recipientSession),
              eq(TeamMessageRecipientTable.delivery_status, "pending"),
            ),
          )
          .all(),
      )
      return rows.map((row) => ({
        id: row.id,
        team_id: row.team_id,
        sender: row.sender,
        recipients: row.recipients,
        body: row.body,
        delivery_status: row.delivery_status,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const markMessageDelivered = Effect.fn("Team.markMessageDelivered")(function* (
      messageID: string,
      recipientSession?: string,
    ) {
      const now = Date.now()
      Database.use(() =>
        db()
          .update(TeamMessageRecipientTable)
          .set({ delivery_status: "delivered", time_updated: now } as any)
          .where(
            recipientSession
              ? and(
                  eq(TeamMessageRecipientTable.message_id, messageID),
                  eq(TeamMessageRecipientTable.recipient, recipientSession),
                )
              : eq(TeamMessageRecipientTable.message_id, messageID),
          )
          .run(),
      )
      const pending = Database.use(() =>
        db()
          .select()
          .from(TeamMessageRecipientTable)
          .where(
            and(
              eq(TeamMessageRecipientTable.message_id, messageID),
              eq(TeamMessageRecipientTable.delivery_status, "pending"),
            ),
          )
          .all(),
      )
      if (pending.length > 0) return
      Database.use(() =>
        db()
          .update(TeamMessageTable)
          .set({ delivery_status: "delivered", time_updated: now } as any)
          .where(eq(TeamMessageTable.id, messageID))
          .run(),
      )
    })

    return Service.of({
      create,
      getActive,
      get,
      shutdown,
      addMember,
      updateMemberStatus,
      getMembers,
      getMemberBySession,
      getContext,
      createTask,
      updateTask,
      claimTask,
      getTasks,
      sendMessage,
      getMessages,
      getPendingMessages,
      markMessageDelivered,
    })
  }).pipe(Effect.withSpan("Team.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionRunState.defaultLayer), Layer.provide(Bus.layer))

export * as Team from "./team"
