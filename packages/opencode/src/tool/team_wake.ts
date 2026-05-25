import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import type { TaskPromptOps } from "./task"

export function wakeTeamSession(ops: TaskPromptOps, sessionID: string): Effect.Effect<void> {
  const id = SessionID.make(sessionID)
  return Effect.gen(function* () {
    yield* ops.wake(id).pipe(Effect.ignore)
    yield* ops.wake(id).pipe(Effect.ignore)
  })
}
