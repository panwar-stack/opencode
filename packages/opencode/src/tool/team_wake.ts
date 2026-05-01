import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import type { TaskPromptOps } from "./task"

export function wakeTeamSession(ops: TaskPromptOps, sessionID: string) {
  const id = SessionID.make(sessionID)
  return Effect.gen(function* () {
    yield* ops.loop({ sessionID: id }).pipe(Effect.ignore)
    yield* ops.loop({ sessionID: id }).pipe(Effect.ignore)
  })
}
