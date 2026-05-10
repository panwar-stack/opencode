export * as ConfigWorkflow from "./workflow"

import { Schema } from "effect"
import { zod } from "@opencode-ai/core/effect-zod"
import { PositiveInt, withStatics } from "@opencode-ai/core/schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the autonomous workflow loop. Defaults to true.",
  }),
  max_steps: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of executor steps before the loop pauses. Defaults to 10.",
  }),
  require_plan_pull_request_approval: Schema.optional(Schema.Boolean).annotate({
    description: "Require Plan PR approval before execution can start. Defaults to true.",
  }),
  require_code_pull_request_approval: Schema.optional(Schema.Boolean).annotate({
    description: "Require Code PR approval before the workflow is considered complete. Defaults to true.",
  }),
  auto_submit_plan: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically submit the Plan PR after the planner finishes. Defaults to false.",
  }),
  auto_submit_code: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically submit the Code PR after the executor finishes. Defaults to false.",
  }),
  plan_reviewer_agent: Schema.optional(Schema.String).annotate({
    description: "Agent to use for plan review sessions.",
  }),
  code_reviewer_agent: Schema.optional(Schema.String).annotate({
    description: "Agent to use for code review sessions.",
  }),
  pull_request_base: Schema.optional(Schema.String).annotate({
    description: "Default base branch for pull requests. Defaults to 'dev'.",
  }),
})
  .annotate({ identifier: "WorkflowConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
