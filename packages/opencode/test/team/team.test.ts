import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Team } from "@/team/team"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "@/permission"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Team.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer))

function unwrap<T>(opt: Option.Option<T>): T {
  if (Option.isNone(opt)) throw new Error("Option is None")
  return (opt as any).value
}

describe("team", () => {
  it.live("create team and enforce one active team per lead", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_1"

        const created = yield* team.create({ name: "test-team", goal: "Test goal", leadSessionID })
        expect(created.name).toBe("test-team")
        expect(created.status).toBe("active")

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isSome(active)).toBe(true)
        expect(unwrap(active).id).toBe(created.id)

        const result = yield* team.create({ name: "dup", goal: "x", leadSessionID }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live("create team after shutdown with same lead session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_recreate"

        const first = yield* team.create({ name: "first-team", goal: "First goal", leadSessionID })
        yield* team.shutdown(first.id)

        const second = yield* team.create({ name: "second-team", goal: "Second goal", leadSessionID })
        expect(second.id).not.toBe(first.id)
        expect(second.status).toBe("active")

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isSome(active)).toBe(true)
        expect(unwrap(active).id).toBe(second.id)

        const closed = yield* team.get(first.id)
        expect(Option.isSome(closed)).toBe(true)
        expect(unwrap(closed).status).toBe("closed")
      }),
    ),
  )

  it.live("add member and get members", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_2"

        yield* team.create({ name: "test-team-2", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_test_child_1",
          name: "builder",
          agentType: "build",
          rolePrompt: "Build the feature",
        })

        expect(member.name).toBe("builder")
        expect(member.agent_type).toBe("build")
        expect(member.status).toBe("starting")

        const members = yield* team.getMembers(teamInfo.id)
        expect(members.length).toBe(1)
        expect(members[0].name).toBe("builder")

        const bySession = yield* team.getMemberBySession("ses_test_child_1")
        expect(Option.isSome(bySession)).toBe(true)
        expect((bySession as any).value.id).toBe(member.id)

        const leadContext = yield* team.getContext(leadSessionID)
        expect(Option.isSome(leadContext)).toBe(true)
        expect(unwrap(leadContext).team.id).toBe(teamInfo.id)

        const memberContext = yield* team.getContext("ses_test_child_1")
        expect(Option.isSome(memberContext)).toBe(true)
        expect(unwrap(memberContext).member.id).toBe(member.id)
      }),
    ),
  )

  it.live("update member status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_3"

        yield* team.create({ name: "test-team-3", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_test_child_2",
          name: "explorer",
          agentType: "explore",
          rolePrompt: "Explore codebase",
        })

        const updated = yield* team.updateMemberStatus(member.id, "active")
        expect(Option.isSome(updated)).toBe(true)
        expect(unwrap(updated).status).toBe("active")

        const completed = yield* team.updateMemberStatus(member.id, "completed")
        expect(Option.isSome(completed)).toBe(true)
        expect(unwrap(completed).status).toBe("completed")
      }),
    ),
  )

  it.live("create and list team tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_4"

        yield* team.create({ name: "test-team-4", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const task1 = yield* team.createTask({
          teamID: teamInfo.id,
          description: "Task 1",
        })
        const task2 = yield* team.createTask({
          teamID: teamInfo.id,
          description: "Task 2",
          assignee: "builder",
          dependencyIDs: [task1.id],
        })

        expect(task1.status).toBe("pending")
        expect(task2.dependency_ids).toContain(task1.id)

        const tasks = yield* team.getTasks(teamInfo.id)
        expect(tasks.length).toBe(2)

        const claimResult = yield* team.claimTask(task2.id, "ses_child")
        expect(Option.isNone(claimResult)).toBe(true)

        yield* team.updateTask(task1.id, { status: "completed" })

        const claim2 = yield* team.claimTask(task2.id, "ses_child")
        expect(Option.isSome(claim2)).toBe(true)
        expect(unwrap(claim2).status).toBe("in_progress")
        expect(unwrap(claim2).assignee).toBe("ses_child")
      }),
    ),
  )

  it.live("send and receive team messages", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_5"

        yield* team.create({ name: "test-team-5", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_a",
          name: "memberA",
          agentType: "general",
          rolePrompt: "Do A",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_b",
          name: "memberB",
          agentType: "general",
          rolePrompt: "Do B",
        })

        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: ["ses_child_a"],
          body: "Hello from lead",
        })

        const pendingA = yield* team.getPendingMessages("ses_child_a", teamInfo.id)
        expect(pendingA.length).toBe(1)
        expect(pendingA[0].sender).toBe(leadSessionID)
        expect(pendingA[0].body).toBe("Hello from lead")

        const pendingB = yield* team.getPendingMessages("ses_child_b", teamInfo.id)
        expect(pendingB.length).toBe(0)

        yield* team.markMessageDelivered(pendingA[0].id)

        const afterDelivery = yield* team.getPendingMessages("ses_child_a", teamInfo.id)
        expect(afterDelivery.length).toBe(0)

        const allMsgs = yield* team.getMessages(teamInfo.id)
        expect(allMsgs.length).toBe(1)
      }),
    ),
  )

  it.live("shutdown team", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_6"

        yield* team.create({ name: "test-team-6", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_c",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })

        yield* team.shutdown(teamInfo.id)

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isNone(active)).toBe(true)

        const info = yield* team.get(teamInfo.id)
        expect(Option.isSome(info)).toBe(true)
        expect(unwrap(info).status).toBe("closed")

        const members = yield* team.getMembers(teamInfo.id)
        expect(members[0].status).toBe("cancelled")
      }),
    ),
  )

  it.live("member-to-lead and member-to-member messaging", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_8"

        yield* team.create({ name: "test-team-8", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_c1",
          name: "memberC",
          agentType: "general",
          rolePrompt: "Do C",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_d1",
          name: "memberD",
          agentType: "general",
          rolePrompt: "Do D",
        })

        // member-to-lead
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: "ses_child_c1",
          recipients: [leadSessionID],
          body: "Status update from C",
        })
        const leadPending = yield* team.getPendingMessages(leadSessionID, teamInfo.id)
        expect(leadPending.length).toBe(1)
        expect(leadPending[0].sender).toBe("ses_child_c1")

        // member-to-member
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: "ses_child_c1",
          recipients: ["ses_child_d1"],
          body: "Hey D, need help",
        })
        const dPending = yield* team.getPendingMessages("ses_child_d1", teamInfo.id)
        expect(dPending.length).toBe(1)
        expect(dPending[0].sender).toBe("ses_child_c1")

        // Verify all messages in the team
        const allMsgs = yield* team.getMessages(teamInfo.id)
        expect(allMsgs.length).toBe(2)
      }),
    ),
  )

  it.live("multi-recipient messages are delivered per recipient", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_multi_delivery"

        yield* team.create({ name: "test-team-multi-delivery", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_multi_a",
          name: "multiA",
          agentType: "general",
          rolePrompt: "Do A",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_multi_b",
          name: "multiB",
          agentType: "general",
          rolePrompt: "Do B",
        })

        const message = yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: ["ses_multi_a", "ses_multi_b"],
          body: "Hello both",
        })

        expect((yield* team.getPendingMessages("ses_multi_a", teamInfo.id)).length).toBe(1)
        expect((yield* team.getPendingMessages("ses_multi_b", teamInfo.id)).length).toBe(1)

        yield* team.markMessageDelivered(message.id, "ses_multi_a")

        expect((yield* team.getPendingMessages("ses_multi_a", teamInfo.id)).length).toBe(0)
        const stillPending = yield* team.getPendingMessages("ses_multi_b", teamInfo.id)
        expect(stillPending.length).toBe(1)
        expect(stillPending[0].body).toBe("Hello both")
      }),
    ),
  )

  it.live("auto-notification on member completion notifies lead", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_9"

        yield* team.create({ name: "test-team-9", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_e",
          name: "workerE",
          agentType: "build",
          rolePrompt: "Build stuff",
        })

        // Update member to completed — subscriber should auto-notify the lead
        yield* team.updateMemberStatus(member.id, "completed")

        // Poll for the notification message (subscriber runs in forked fiber)
        let notified = false
        for (let i = 0; i < 20; i++) {
          const msgs = yield* team.getMessages(teamInfo.id)
          const found = msgs.find(
            (m: any) =>
              m.sender === member.session_id &&
              m.recipients.includes(leadSessionID) &&
              m.body.includes("completed their work"),
          )
          if (found) {
            notified = true
            break
          }
          yield* Effect.sleep("5 millis")
        }
        expect(notified).toBe(true)
      }),
    ),
  )

  it.live("pending messages stay pending until consumed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_10"

        yield* team.create({ name: "test-team-10", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_f",
          name: "workerF",
          agentType: "general",
          rolePrompt: "General work",
        })

        // Send a message to the member
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: [member.session_id],
          body: "Update your status",
        })

        // Message should be pending
        const pending = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(pending.length).toBe(1)

        yield* team.updateMemberStatus(member.id, "idle")

        const stillPending = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(stillPending.length).toBe(1)

        yield* team.markMessageDelivered(pending[0].id)

        const consumed = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(consumed.length).toBe(0)
      }),
    ),
  )

  it.live("member added with plan_mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_11"

        yield* team.create({ name: "test-team-11", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_g",
          name: "planner",
          agentType: "build",
          rolePrompt: "Plan first",
          planMode: true,
          workMode: "plan",
        })

        expect(member.plan_mode).toBe(true)
        expect(member.work_mode).toBe("plan")
        expect(member.status).toBe("starting")
      }),
    ),
  )

  it.live("plan approval transitions member from plan_mode to active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_12"

        yield* team.create({ name: "test-team-12", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_h",
          name: "planner2",
          agentType: "build",
          rolePrompt: "Plan first",
          planMode: true,
          workMode: "plan",
        })

        const updated = yield* team.updateMemberStatus(member.id, "active")
        expect(Option.isSome(updated)).toBe(true)
        expect(unwrap(updated).status).toBe("active")
        expect(unwrap(updated).plan_mode).toBe(true)
        expect(unwrap(updated).work_mode).toBe("plan")
      }),
    ),
  )

  it.live("broadcast sends message to all active members", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_broadcast"

        yield* team.create({ name: "test-broadcast", goal: "Test broadcast", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member1 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_1",
          name: "broad1",
          agentType: "explore",
          rolePrompt: "Explore",
        })
        const member2 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_2",
          name: "broad2",
          agentType: "build",
          rolePrompt: "Build",
        })
        const member3 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_3",
          name: "broad3",
          agentType: "general",
          rolePrompt: "General",
        })

        yield* team.updateMemberStatus(member1.id, "active")
        yield* team.updateMemberStatus(member2.id, "active")
        // member3 stays "starting"

        // Simulate broadcast: send to all active + starting members
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: [member1.session_id, member2.session_id, member3.session_id],
          body: "Broadcast: new priority task",
        })

        const pending1 = yield* team.getPendingMessages(member1.session_id, teamInfo.id)
        const pending2 = yield* team.getPendingMessages(member2.session_id, teamInfo.id)
        const pending3 = yield* team.getPendingMessages(member3.session_id, teamInfo.id)

        expect(pending1.length).toBe(1)
        expect(pending1[0].body).toBe("Broadcast: new priority task")
        expect(pending2.length).toBe(1)
        expect(pending2[0].body).toBe("Broadcast: new priority task")
        expect(pending3.length).toBe(1)
        expect(pending3[0].body).toBe("Broadcast: new priority task")

        // Non-existent session gets nothing
        const noop = yield* team.getPendingMessages("ses_nonexistent", teamInfo.id)
        expect(noop.length).toBe(0)
      }),
    ),
  )

  it.effect("plan approval permission filter removes write deny rules", () =>
    Effect.sync(() => {
      const rules: Permission.Rule[] = [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "apply_patch", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "**", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ]

      const filtered = rules.filter(
        (rule) =>
          !(
            rule.action === "deny" &&
            rule.pattern === "*" &&
            (rule.permission === "edit" ||
              rule.permission === "write" ||
              rule.permission === "bash" ||
              rule.permission === "apply_patch")
          ),
      )

      expect(filtered.length).toBe(3)
      expect(filtered.find((r) => r.permission === "read")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "external_directory")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "todowrite")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "bash")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "write")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "edit")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "apply_patch")).toBeUndefined()
    }),
  )
})
