import { Slug } from "@opencode-ai/core/util/slug"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { ProviderMetadata, Usage } from "@opencode-ai/llm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { SyncEvent } from "../sync"
import type { SQL } from "drizzle-orm"
import { PartTable, SessionRootTable, SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Project } from "../project/project"
import { Storage } from "@/storage/storage"
import * as Log from "@opencode-ai/core/util/log"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID, SessionRootID } from "./schema"
import { ModelID, ProviderID } from "@/provider/schema"

import type { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optionalOmitUndefined } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

const log = Log.create({ service: "session" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect
type SessionRootRow = typeof SessionRootTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelID.make(row.model.id),
          providerID: ProviderID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    revert,
    permission: row.permission ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
      processing: row.time_processing,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    time_processing: info.time.processing,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

export function rootFromRow(row: SessionRootRow): RootInfo {
  return {
    id: row.id,
    sessionID: row.session_id,
    name: row.name ?? undefined,
    directory: row.directory,
    worktree: row.worktree,
    projectID: row.project_id,
    path: row.path ?? undefined,
    created: row.created,
    primary: row.primary,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optionalOmitUndefined(Schema.Array(Snapshot.FileDiff)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optionalOmitUndefined(NonNegativeInt),
  archived: optionalOmitUndefined(ArchivedTimestamp),
  processing: NonNegativeInt,
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

const Model = Schema.Struct({
  id: ModelID,
  providerID: ProviderID,
  variant: optionalOmitUndefined(Schema.String),
})

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(Tokens),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const RootInfo = Schema.Struct({
  id: SessionRootID,
  sessionID: SessionID,
  name: optionalOmitUndefined(Schema.String),
  directory: Schema.String,
  worktree: Schema.String,
  projectID: ProjectID,
  path: optionalOmitUndefined(Schema.String),
  created: NonNegativeInt,
  primary: Schema.Boolean,
}).annotate({ identifier: "SessionRoot" })
export type RootInfo = Types.DeepMutable<Schema.Schema.Type<typeof RootInfo>>

export const ProjectInfo = Schema.Struct({
  id: ProjectID,
  name: optionalOmitUndefined(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    permission: Schema.optional(Permission.Ruleset),
    workspaceID: Schema.optional(WorkspaceID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: Permission.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

const CreatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: Info,
})

const UpdatedShare = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const UpdatedTime = Schema.Struct({
  created: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updated: Schema.optional(Schema.NullOr(NonNegativeInt)),
  compacting: Schema.optional(Schema.NullOr(NonNegativeInt)),
  archived: Schema.optional(Schema.NullOr(ArchivedTimestamp)),
  processing: Schema.optional(Schema.NullOr(NonNegativeInt)),
})

const UpdatedInfo = Schema.Struct({
  id: Schema.optional(Schema.NullOr(SessionID)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  projectID: Schema.optional(Schema.NullOr(ProjectID)),
  workspaceID: Schema.optional(Schema.NullOr(WorkspaceID)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  parentID: Schema.optional(Schema.NullOr(SessionID)),
  summary: Schema.optional(Schema.NullOr(Summary)),
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Tokens),
  share: Schema.optional(UpdatedShare),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Model)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  time: Schema.optional(UpdatedTime),
  permission: Schema.optional(Schema.NullOr(Permission.Ruleset)),
  revert: Schema.optional(Schema.NullOr(Revert)),
})

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: UpdatedInfo,
})

export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: CreatedEventSchema,
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: UpdatedEventSchema,
    busSchema: CreatedEventSchema,
  }),
  Deleted: SyncEvent.define({
    type: "session.deleted",
    version: 1,
    aggregate: "sessionID",
    schema: CreatedEventSchema,
  }),
  Diff: BusEvent.define(
    "session.diff",
    Schema.Struct({
      sessionID: SessionID,
      diff: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    Schema.Struct({
      sessionID: Schema.optional(SessionID),
      // Reuses MessageV2.Assistant.fields.error (already Schema.optional) so
      // the derived zod keeps the same discriminated-union shape on the bus.
      error: MessageV2.Assistant.fields.error,
    }),
  ),
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  return {
    cost: safe(
      new Decimal(0)
        .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
        .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
        // TODO: update models.dev to have better pricing model, for now:
        // charge reasoning tokens at the same rate as output tokens
        .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
        .toNumber(),
    ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export class RootError extends Schema.TaggedErrorClass<RootError>()("SessionRootError", {
  message: Schema.String,
}) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    permission?: Permission.Ruleset
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: Permission.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[], NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly listRoots: (sessionID: SessionID) => Effect.Effect<RootInfo[], NotFound>
  readonly addRoot: (input: {
    sessionID: SessionID
    directory: string
    name?: string
  }) => Effect.Effect<RootInfo, NotFound | RootError>
  readonly updateRoot: (input: {
    sessionID: SessionID
    rootID: SessionRootID
    name?: string
    primary?: boolean
  }) => Effect.Effect<RootInfo, NotFound>
  readonly removeRoot: (input: {
    sessionID: SessionID
    rootID: SessionRootID
  }) => Effect.Effect<void, NotFound | RootError>
  readonly getPrimaryRoot: (sessionID: SessionID) => Effect.Effect<RootInfo, NotFound | RootError>
  readonly updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<MessageV2.Part | undefined>
  readonly updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

export type Patch = Types.DeepMutable<SyncEvent.Event<typeof Event.Updated>["data"]["info"]>

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

export const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | Bus.Service | Storage.Service | SyncEvent.Service | RuntimeFlags.Service | Project.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const storage = yield* Storage.Service
    const sync = yield* SyncEvent.Service
    const flags = yield* RuntimeFlags.Service
    const project = yield* Project.Service

    const listRootRows = (sessionID: SessionID) =>
      db((d) =>
        d
          .select()
          .from(SessionRootTable)
          .where(eq(SessionRootTable.session_id, sessionID))
          .orderBy(SessionRootTable.created, SessionRootTable.id)
          .all(),
      )

    const getRootRow = Effect.fn("Session.getRootRow")(function* (input: {
      sessionID: SessionID
      rootID: SessionRootID
    }) {
      const row = yield* db((d) =>
        d
          .select()
          .from(SessionRootTable)
          .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, input.rootID)))
          .get(),
      )
      if (!row) return yield* new NotFoundError({ message: `Session root not found: ${input.rootID}` })
      return row
    })

    const insertRoot = (input: {
      sessionID: SessionID
      name?: string
      directory: string
      worktree: string
      projectID: ProjectID
      path?: string
      created: number
      primary: boolean
    }) =>
      db((d) =>
        d
          .insert(SessionRootTable)
          .values({
            id: SessionRootID.ascending(),
            session_id: input.sessionID,
            name: input.name,
            directory: input.directory,
            worktree: input.worktree,
            project_id: input.projectID,
            path: input.path,
            created: input.created,
            primary: input.primary,
          })
          .returning()
          .get(),
      )

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
      path?: string
      permission?: Permission.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? createDefaultTitle(!!input.parentID),
        agent: input.agent,
        model: input.model,
        permission: input.permission,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
          processing: 0,
        },
      }
      log.info("created", result)

      yield* sync.run(Event.Created, { sessionID: result.id, info: result })
      yield* insertRoot({
        sessionID: result.id,
        directory: result.directory,
        worktree: ctx.worktree,
        projectID: ctx.project.id,
        path: result.path,
        created: result.time.created,
        primary: true,
      })

      if (!flags.experimentalWorkspaces) {
        // This only exist for backwards compatibility. We should not be
        // manually publishing this event; it is a sync event now
        yield* bus.publish(Event.Updated, {
          sessionID: result.id,
          info: result,
        })
      }

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return Array.from(
        listByProject({ projectID: ctx.project.id, experimentalWorkspaces: flags.experimentalWorkspaces, ...input }),
      )
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionTable)
          .where(and(eq(SessionTable.parent_id, parentID)))
          .all(),
      )
      return rows.map(fromRow)
    })

    const listRoots = Effect.fn("Session.listRoots")(function* (sessionID: SessionID) {
      yield* get(sessionID)
      return (yield* listRootRows(sessionID)).map(rootFromRow)
    })

    const getPrimaryRoot = Effect.fn("Session.getPrimaryRoot")(function* (sessionID: SessionID) {
      yield* get(sessionID)
      const row = yield* db((d) =>
        d
          .select()
          .from(SessionRootTable)
          .where(and(eq(SessionRootTable.session_id, sessionID), eq(SessionRootTable.primary, true)))
          .get(),
      )
      if (!row) return yield* new RootError({ message: `Session has no primary root: ${sessionID}` })
      return rootFromRow(row)
    })

    const addRoot = Effect.fn("Session.addRoot")(function* (input: {
      sessionID: SessionID
      directory: string
      name?: string
    }) {
      yield* get(input.sessionID)
      const directory = path.resolve(input.directory)
      const result = yield* project.fromDirectory(directory)
      const row = yield* db((d) =>
        d
          .insert(SessionRootTable)
          .values({
            id: SessionRootID.ascending(),
            session_id: input.sessionID,
            name: input.name,
            directory,
            worktree: result.project.worktree,
            project_id: result.project.id,
            path: sessionPath(result.project.worktree, directory),
            created: Date.now(),
            primary: false,
          })
          .onConflictDoNothing()
          .returning()
          .get(),
      )
      if (!row) return yield* new RootError({ message: `Session root already exists: ${directory}` })
      return rootFromRow(row)
    })

    const updateRoot = Effect.fn("Session.updateRoot")(function* (input: {
      sessionID: SessionID
      rootID: SessionRootID
      name?: string
      primary?: boolean
    }) {
      const current = yield* getRootRow(input)
      if (!input.primary) {
        const row = yield* db((d) =>
          d
            .update(SessionRootTable)
            .set({ name: input.name ?? current.name })
            .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, input.rootID)))
            .returning()
            .get(),
        )
        if (!row) return yield* new NotFoundError({ message: `Session root not found: ${input.rootID}` })
        return rootFromRow(row)
      }

      const row = yield* Effect.sync(() =>
        Database.transaction(
          (tx) => {
            const target = tx
              .select()
              .from(SessionRootTable)
              .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, input.rootID)))
              .get()
            if (!target) return undefined
            tx.update(SessionRootTable)
              .set({ primary: false })
              .where(eq(SessionRootTable.session_id, input.sessionID))
              .run()
            const updated = tx
              .update(SessionRootTable)
              .set({ name: input.name ?? target.name, primary: true })
              .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, input.rootID)))
              .returning()
              .get()
            tx.update(SessionTable)
              .set({
                directory: updated.directory,
                path: updated.path,
                project_id: updated.project_id,
                time_updated: Date.now(),
              })
              .where(eq(SessionTable.id, input.sessionID))
              .run()
            return updated
          },
          { behavior: "immediate" },
        ),
      )
      if (!row) return yield* new NotFoundError({ message: `Session root not found: ${input.rootID}` })
      return rootFromRow(row)
    })

    const removeRoot = Effect.fn("Session.removeRoot")(function* (input: {
      sessionID: SessionID
      rootID: SessionRootID
    }) {
      yield* get(input.sessionID)
      const result = yield* Effect.sync(() =>
        Database.transaction(
          (tx) => {
            const roots = tx
              .select()
              .from(SessionRootTable)
              .where(eq(SessionRootTable.session_id, input.sessionID))
              .orderBy(SessionRootTable.created, SessionRootTable.id)
              .all()
            const target = roots.find((root) => root.id === input.rootID)
            if (!target) return "not_found" as const
            if (roots.length === 1) return "last_root" as const

            tx.delete(SessionRootTable)
              .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, input.rootID)))
              .run()

            if (!target.primary) return "removed" as const

            const fallback = tx
              .select()
              .from(SessionRootTable)
              .where(eq(SessionRootTable.session_id, input.sessionID))
              .orderBy(SessionRootTable.created, SessionRootTable.id)
              .get()
            if (!fallback) return "last_root" as const
            tx.update(SessionRootTable)
              .set({ primary: true })
              .where(and(eq(SessionRootTable.session_id, input.sessionID), eq(SessionRootTable.id, fallback.id)))
              .run()
            tx.update(SessionTable)
              .set({
                directory: fallback.directory,
                path: fallback.path,
                project_id: fallback.project_id,
                time_updated: Date.now(),
              })
              .where(eq(SessionTable.id, input.sessionID))
              .run()
            return "removed" as const
          },
          { behavior: "immediate" },
        ),
      )
      if (result === "not_found")
        return yield* new NotFoundError({ message: `Session root not found: ${input.rootID}` })
      if (result === "last_root") return yield* new RootError({ message: "Cannot delete the last session root" })
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        yield* sync.run(Event.Deleted, { sessionID, info: session }, { publish: hasInstance })
        yield* sync.remove(sessionID)
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* sync.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* sync.run(MessageV2.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, input.messageID),
              eq(PartTable.id, input.partID),
            ),
          )
          .get(),
      )
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as MessageV2.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      permission?: Permission.Ruleset
      workspaceID?: WorkspaceID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = yield* updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const p: MessageV2.Part = {
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          }
          if (p.type === "compaction" && p.tail_start_id) {
            p.tail_start_id = idMap.get(p.tail_start_id)
          }
          yield* updatePart(p)
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) => sync.run(Event.Updated, { sessionID, info })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } })
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title })
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } })
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: Permission.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: input.permission, time: { updated: Date.now() } })
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { summary: input.summary, time: { updated: Date.now() }, revert: input.revert })
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null })
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary })
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      return yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", sessionID])
        .pipe(Effect.orElseSucceed((): Snapshot.FileDiff[] => []))
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      if (input.limit) {
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit })).items
      }

      const size = 50
      const result = [] as MessageV2.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before })
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sync.run(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* sync.run(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* bus.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before })
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<MessageV2.WithParts>()
    })

    return Service.of({
      list,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      diff,
      messages,
      children,
      remove,
      listRoots,
      addRoot,
      updateRoot,
      removeRoot,
      getPrimaryRoot,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(Project.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function* listByProject(
  input: ListInput & {
    projectID: ProjectID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [eq(SessionTable.path, input.path), like(SessionTable.path, `${input.path}/%`)]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project" && !input.experimentalWorkspaces) {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  const rows = Database.use((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(...conditions))
      .orderBy(desc(SessionTable.time_updated))
      .limit(limit)
      .all(),
  )
  for (const row of rows) {
    yield fromRow(row)
  }
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}) {
  const conditions: SQL[] = []

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor) {
    conditions.push(lt(SessionTable.time_updated, input.cursor))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (!input?.archived) {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  const rows = Database.use((db) => {
    const query =
      conditions.length > 0
        ? db
            .select()
            .from(SessionTable)
            .where(and(...conditions))
        : db.select().from(SessionTable)
    return query.orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(limit).all()
  })

  const ids = [...new Set(rows.map((row) => row.project_id))]
  const projects = new Map<string, ProjectInfo>()

  if (ids.length > 0) {
    const items = Database.use((db) =>
      db
        .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all(),
    )
    for (const item of items) {
      projects.set(item.id, {
        id: item.id,
        name: item.name ?? undefined,
        worktree: item.worktree,
      })
    }
  }

  for (const row of rows) {
    const project = projects.get(row.project_id) ?? null
    yield { ...fromRow(row), project }
  }
}

export * as Session from "./session"
