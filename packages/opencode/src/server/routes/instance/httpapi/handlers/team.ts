import { TeamEval } from "@/team/eval"
import { Team } from "@/team/team"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const teamHandlers = HttpApiBuilder.group(InstanceHttpApi, "team", (handlers) =>
  Effect.gen(function* () {
    const team = yield* Team.Service

    const getBySession = Effect.fn("TeamHttpApi.getBySession")(function* (ctx: { query: { sessionID: string } }) {
      const result = yield* team.getActive(ctx.query.sessionID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      return result.value
    })

    const getByTeam = Effect.fn("TeamHttpApi.getByTeam")(function* (ctx: { params: { teamID: string } }) {
      const result = yield* team.get(ctx.params.teamID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      return result.value
    })

    const getTasks = Effect.fn("TeamHttpApi.getTasks")(function* (ctx: { params: { teamID: string } }) {
      return yield* team.getTasks(ctx.params.teamID)
    })

    const getMessages = Effect.fn("TeamHttpApi.getMessages")(function* (ctx: { params: { teamID: string } }) {
      return yield* team.getMessages(ctx.params.teamID)
    })

    const getEval = Effect.fn("TeamHttpApi.getEval")(function* (ctx: { params: { teamID: string } }) {
      return yield* TeamEval.build(ctx.params.teamID).pipe(
        Effect.catchTag("TeamEval.NotFoundError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
    })

    const shutdown = Effect.fn("TeamHttpApi.shutdown")(function* (ctx: { params: { teamID: string } }) {
      yield* team.shutdown(ctx.params.teamID)
      return true
    })

    return handlers
      .handle("getBySession", getBySession)
      .handle("getByTeam", getByTeam)
      .handle("getEval", getEval)
      .handle("getTasks", getTasks)
      .handle("getMessages", getMessages)
      .handle("shutdown", shutdown)
  }),
)
