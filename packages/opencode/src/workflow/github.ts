import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"
import { Context, Effect, Layer } from "effect"
import type { PullRequestState, ReviewComment, ReviewState } from "./state"

type GhAuthor = {
  readonly login?: string
}

type GhComment = {
  readonly id?: string
  readonly url?: string
  readonly author?: GhAuthor | null
  readonly body?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

type GhReview = GhComment & {
  readonly state?: string
  readonly submittedAt?: string
}

type GhPullRequestView = {
  readonly number?: number
  readonly url?: string
  readonly headRefName?: string
  readonly headRefOid?: string
  readonly state?: string
  readonly reviewDecision?: string | null
  readonly comments?: readonly GhComment[]
  readonly reviews?: readonly GhReview[]
}

type PullRequestInfo = {
  readonly number: number
  readonly url: string
  readonly head_branch: string
  readonly head_commit: string
  readonly review_state: ReviewState
  readonly body?: string
}

type GraphqlReview = {
  readonly author?: { readonly login?: string } | null
  readonly state?: string
  readonly submittedAt?: string
  readonly url?: string
}

type GraphqlPullRequestReviewState = {
  readonly repository?: {
    readonly pullRequest?: {
      readonly reviewDecision?: string | null
      readonly latestOpinionatedReviews?: {
        readonly nodes?: readonly GraphqlReview[]
      }
    } | null
  } | null
}

export function normalizeReviewState(input?: string | null): ReviewState {
  if (!input) return "pending"
  const value = input.toLowerCase()
  if (value === "approved") return "approved"
  if (value === "changes_requested") return "changes_requested"
  if (value === "review_required") return "pending"
  if (value === "commented") return "commented"
  if (value === "merged") return "merged"
  if (value === "closed") return "commented"
  return "pending"
}

export function reviewStateFromPullRequest(input: Pick<GhPullRequestView, "state" | "reviewDecision">): ReviewState {
  if (input.state === "MERGED" || input.state === "merged") return "merged"
  return normalizeReviewState(input.reviewDecision)
}

export function commentsFromPullRequest(input: GhPullRequestView): readonly ReviewComment[] {
  return [
    ...(input.comments ?? []).map((comment) => ({
      id: comment.id ?? comment.url ?? `issue-${comment.createdAt ?? "unknown"}`,
      url: comment.url,
      author: comment.author?.login,
      body: comment.body ?? "",
      state: "open" as const,
      source: "issue_comment" as const,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
    ...(input.reviews ?? []).flatMap((review) => {
      if (!review.body) return []
      return [
        {
          id: review.id ?? review.url ?? `review-${review.submittedAt ?? "unknown"}`,
          url: review.url,
          author: review.author?.login,
          body: review.body,
          state: "open" as const,
          source: "review" as const,
          created_at: review.submittedAt,
          updated_at: review.updatedAt,
        },
      ]
    }),
  ].filter((comment) => comment.body.trim().length > 0)
}

export function pullRequestStateFromGh(input: GhPullRequestView): PullRequestState {
  const reviews = input.reviews ?? []
  const latest = reviews
    .filter((review) => review.submittedAt || review.updatedAt || review.createdAt)
    .toSorted((a, b) =>
      new Date(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").getTime() -
      new Date(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "").getTime(),
    )[0]
  const latestApproval = reviews
    .filter((review) => review.state?.toLowerCase() === "approved")
    .toSorted((a, b) =>
      new Date(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").getTime() -
      new Date(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "").getTime(),
    )[0]
  return {
    number: input.number,
    url: input.url,
    branch: input.headRefName,
    head_commit: input.headRefOid,
    review_state: reviewStateFromPullRequest(input),
    reviewers: [
      ...new Set(reviews.map((review) => review.author?.login).filter((login): login is string => Boolean(login))),
    ],
    latest_review_at: latest?.submittedAt ?? latest?.updatedAt ?? latest?.createdAt,
    latest_review_url: latest?.url,
    approved_by: latestApproval?.author?.login,
    approved_at: latestApproval?.submittedAt ?? latestApproval?.updatedAt ?? latestApproval?.createdAt,
    comments: commentsFromPullRequest(input),
  }
}

export function mergeCommentState(
  previous: readonly ReviewComment[],
  next: readonly ReviewComment[],
): readonly ReviewComment[] {
  const previousByID = new Map(previous.map((comment) => [comment.id, comment]))
  return next.map((comment) => ({
    ...comment,
    state: previousByID.get(comment.id)?.state ?? comment.state,
  }))
}

function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
}

function parseRepo(repo: string) {
  const [owner, name] = repo.split("/")
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo}. Expected owner/name.`)
  return { owner, repo: name }
}

export interface Interface {
  readonly createPullRequest: (
    repo: string,
    base: string,
    head: string,
    title: string,
    body: string,
  ) => Effect.Effect<PullRequestInfo>

  readonly getPullRequest: (repo: string, prNumber: number) => Effect.Effect<PullRequestInfo>

  readonly listIssueComments: (
    repo: string,
    prNumber: number,
  ) => Effect.Effect<readonly ReviewComment[]>

  readonly listReviewComments: (
    repo: string,
    prNumber: number,
  ) => Effect.Effect<readonly ReviewComment[]>

  readonly getReviews: (repo: string, prNumber: number) => Effect.Effect<ReviewState>

  readonly addComment: (
    repo: string,
    prNumber: number,
    body: string,
  ) => Effect.Effect<void>

  readonly addReplyToComment: (
    repo: string,
    prNumber: number,
    commentId: string,
    body: string,
  ) => Effect.Effect<void>

  readonly getPullRequestState: (
    repo: string,
    prNumber: number,
  ) => Effect.Effect<PullRequestState>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowGithub") {}

function intoPrInfo(pr: {
  number: number
  html_url: string
  head: { ref: string; sha: string }
  body?: string | null
  draft?: boolean
  state?: string
}): PullRequestInfo {
  return {
    number: pr.number,
    url: pr.html_url,
    head_branch: pr.head.ref,
    head_commit: pr.head.sha,
    review_state: pr.state === "merged" ? "merged" : undefined as unknown as ReviewState,
    body: pr.body ?? undefined,
  }
}

function intoReviewComment(
  comment: {
    id: number
    html_url?: string
    user?: { login: string } | null
    body?: string
    created_at: string
    updated_at: string
    path?: string
    line?: number
  },
  source: "issue_comment" | "review_comment" | "review",
): ReviewComment {
  return {
    id: String(comment.id),
    url: comment.html_url,
    author: comment.user?.login,
    body: comment.body ?? "",
    state: "open",
    source,
    path: comment.path,
    line: comment.line,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const token = getToken()

    const octokit = Effect.sync(() => new Octokit({ auth: token })).pipe(Effect.map((o) => o.rest))
    const graphqlClient = Effect.sync(() =>
      graphql.defaults(token ? { headers: { authorization: `token ${token}` } } : {}),
    )

    const getGraphqlReviewState = Effect.fn("WorkflowGithub.getGraphqlReviewState")(function* (
      repo: string,
      prNumber: number,
    ) {
      const client = yield* graphqlClient
      const { owner, repo: repoName } = parseRepo(repo)
      return yield* Effect.promise(() =>
        client<GraphqlPullRequestReviewState>(
          `query PullRequestReviewState($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewDecision
                latestOpinionatedReviews(last: 20) {
                  nodes {
                    author { login }
                    state
                    submittedAt
                    url
                  }
                }
              }
            }
          }`,
          { owner, repo: repoName, number: prNumber },
        ),
      ).pipe(
        Effect.map((result) => {
          const reviews = result.repository?.pullRequest?.latestOpinionatedReviews?.nodes ?? []
          const latest = reviews
            .filter((review) => review.submittedAt)
            .toSorted((a, b) => new Date(b.submittedAt ?? "").getTime() - new Date(a.submittedAt ?? "").getTime())[0]
          const latestApproval = reviews
            .filter((review) => review.state === "APPROVED")
            .toSorted((a, b) => new Date(b.submittedAt ?? "").getTime() - new Date(a.submittedAt ?? "").getTime())[0]
          return {
            reviewDecision: result.repository?.pullRequest?.reviewDecision,
            reviewers: [
              ...new Set(reviews.map((review) => review.author?.login).filter((login): login is string => Boolean(login))),
            ],
            latest_review_at: latest?.submittedAt,
            latest_review_url: latest?.url,
            approved_by: latestApproval?.author?.login,
            approved_at: latestApproval?.submittedAt,
          }
        }),
        Effect.catch(() =>
          Effect.succeed({
            reviewDecision: undefined,
            reviewers: [] as readonly string[],
            latest_review_at: undefined,
            latest_review_url: undefined,
            approved_by: undefined,
            approved_at: undefined,
          }),
        ),
      )
    })

    const getPr = Effect.fn("WorkflowGithub.getPullRequest")(function* (repo: string, prNumber: number) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      const { data } = yield* Effect.promise(() =>
        api.pulls.get({ owner, repo: repoName, pull_number: prNumber }),
      )
      return intoPrInfo(data)
    })

    const getPullRequestState = Effect.fn("WorkflowGithub.getPullRequestState")(function* (
      repo: string,
      prNumber: number,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)

      const [pr, issueComments, reviewComments, reviews] = yield* Effect.all(
        [
          Effect.promise(() => api.pulls.get({ owner, repo: repoName, pull_number: prNumber })),
          Effect.promise(() =>
            api.issues.listComments({ owner, repo: repoName, issue_number: prNumber, per_page: 100 }),
          ),
          Effect.promise(() =>
            api.pulls.listReviewComments({ owner, repo: repoName, pull_number: prNumber, per_page: 100 }),
          ),
          Effect.promise(() =>
            api.pulls.listReviews({ owner, repo: repoName, pull_number: prNumber, per_page: 100 }),
          ),
        ],
        { concurrency: 4 },
      )
      const graphqlReviewState = yield* getGraphqlReviewState(repo, prNumber)

      const reviewDecision = reviews.data.length > 0
        ? reviews.data
            .filter((r) => r.state !== "COMMENTED")
            .toReversed()
            .map((r) => r.state)
            .find(() => true)
        : undefined

      const reviewCommentsNormalized = reviewComments.data.map((c) =>
        intoReviewComment(
          {
            id: c.id,
            html_url: c.html_url,
            user: c.user,
            body: c.body,
            created_at: c.created_at,
            updated_at: c.updated_at,
            path: c.path ?? undefined,
            line: c.line ?? undefined,
          },
          "review_comment",
        ),
      )

      const reviewBodies = reviews.data
        .filter((r) => r.body && r.body.trim().length > 0)
        .map((r) =>
          intoReviewComment(
            {
              id: r.id,
              html_url: r.html_url,
              user: r.user,
              body: r.body ?? "",
              created_at: r.submitted_at ?? "",
              updated_at: r.submitted_at ?? "",
            },
            "review",
          ),
        )

      return {
        number: pr.data.number,
        url: pr.data.html_url,
        branch: pr.data.head.ref,
        head_commit: pr.data.head.sha,
        review_state: reviewStateFromPullRequest({
          state: pr.data.state,
          reviewDecision: graphqlReviewState.reviewDecision ?? reviewDecision,
        }),
        reviewers: graphqlReviewState.reviewers.length > 0
          ? graphqlReviewState.reviewers
          : [
              ...new Set(
                reviews.data.map((review) => review.user?.login).filter((login): login is string => Boolean(login)),
              ),
            ],
        latest_review_at: graphqlReviewState.latest_review_at ?? reviewBodies[0]?.created_at,
        latest_review_url: graphqlReviewState.latest_review_url ?? reviewBodies[0]?.url,
        approved_by: graphqlReviewState.approved_by ?? reviewBodies.find((review) => review.body)?.author,
        approved_at: graphqlReviewState.approved_at,
        comments: [
          ...issueComments.data.map((c) =>
            intoReviewComment(
              {
                id: c.id,
                html_url: c.html_url,
                user: c.user,
                body: c.body ?? "",
                created_at: c.created_at,
                updated_at: c.updated_at,
              },
              "issue_comment",
            ),
          ),
          ...reviewCommentsNormalized,
          ...reviewBodies,
        ],
      }
    })

    const createPullRequest = Effect.fn("WorkflowGithub.createPullRequest")(function* (
      repo: string,
      base: string,
      head: string,
      title: string,
      body: string,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      const { data } = yield* Effect.promise(() =>
        api.pulls.create({
          owner,
          repo: repoName,
          title,
          head,
          base,
          body,
        }),
      )
      return intoPrInfo(data)
    })

    const listIssueComments = Effect.fn("WorkflowGithub.listIssueComments")(function* (
      repo: string,
      prNumber: number,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      const { data } = yield* Effect.promise(() =>
        api.issues.listComments({
          owner,
          repo: repoName,
          issue_number: prNumber,
          per_page: 100,
        }),
      )
      return data.map((c) => intoReviewComment(c as any, "issue_comment"))
    })

    const listReviewComments = Effect.fn("WorkflowGithub.listReviewComments")(function* (
      repo: string,
      prNumber: number,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      const { data } = yield* Effect.promise(() =>
        api.pulls.listReviewComments({
          owner,
          repo: repoName,
          pull_number: prNumber,
          per_page: 100,
        }),
      )
      return data.map((c) => intoReviewComment(c as any, "review_comment"))
    })

    const getReviews = Effect.fn("WorkflowGithub.getReviews")(function* (repo: string, prNumber: number) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      const { data } = yield* Effect.promise(() =>
        api.pulls.listReviews({
          owner,
          repo: repoName,
          pull_number: prNumber,
          per_page: 100,
        }),
      )
      const last = data
        .filter((r) => r.state && r.state !== "COMMENTED")
        .toReversed()
        .map((r) => r.state)
        .find(() => true)
      return normalizeReviewState(last)
    })

    const addComment = Effect.fn("WorkflowGithub.addComment")(function* (
      repo: string,
      prNumber: number,
      body: string,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      yield* Effect.promise(() =>
        api.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body,
        }),
      )
    })

    const addReplyToComment = Effect.fn("WorkflowGithub.addReplyToComment")(function* (
      repo: string,
      prNumber: number,
      commentId: string,
      body: string,
    ) {
      const api = yield* octokit
      const { owner, repo: repoName } = parseRepo(repo)
      yield* Effect.promise(() =>
        api.pulls.createReplyForReviewComment({
          owner,
          repo: repoName,
          pull_number: prNumber,
          comment_id: Number(commentId),
          body,
        }),
      )
    })

    return Service.of({
      createPullRequest,
      getPullRequest: getPr,
      listIssueComments,
      listReviewComments,
      getReviews,
      addComment,
      addReplyToComment,
      getPullRequestState,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowGithub from "./github"
