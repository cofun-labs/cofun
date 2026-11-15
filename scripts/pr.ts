// pnpm pr <ready|resolve> <pr-number>: the steps before a merge, so they are not done by hand
// (see "Merging" in docs/development.md). `ready` checks that a PR can merge and prints the merge
// command, without running it; `resolve` resolves every review thread the PR's author
// answered last, except a user's call, which waits for the user. Both run `gh` with the login on this machine.
import { execFileSync } from 'node:child_process'
import * as z from 'zod'

/** What is wrong with the arguments, said so that whoever typed them can correct them. */
class ArgumentError extends Error {}

/** Runs `gh` and returns what it printed. */
function gh(args: readonly string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/** Runs a GraphQL query with `gh api graphql` and returns its `data`, parsed by `schema`. */
function graphql<T>(query: string, variables: Record<string, string | number>, schema: z.ZodType<T>): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`)
  }
  return z.object({ data: schema }).parse(JSON.parse(gh(args))).data
}

const login = z.object({ login: z.string() }).nullable()
const page = z.object({ hasNextPage: z.boolean() })

const PULL_REQUEST = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft baseRefName headRefOid body
      author { login }
      autoMergeRequest { enabledAt }
      closingIssuesReferences(first: 20) { pageInfo { hasNextPage } nodes { number body } }
      commits(last: 100) { pageInfo: pageInfo { hasNextPage: hasPreviousPage } nodes { commit { oid } } }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      head: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      comments(last: 100) { pageInfo: pageInfo { hasNextPage: hasPreviousPage } nodes { author { login } body } }
      reviews(last: 100) { pageInfo: pageInfo { hasNextPage: hasPreviousPage } nodes { author { login } body } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved path
          comments(first: 100) { nodes { author { login } body } }
        }
      }
    }
  }
}`

const comment = z.object({ author: login, body: z.string() })

const pullRequestSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      state: z.string(),
      isDraft: z.boolean(),
      baseRefName: z.string(),
      headRefOid: z.string(),
      body: z.string(),
      author: login,
      autoMergeRequest: z.object({ enabledAt: z.string().nullable() }).nullable(),
      closingIssuesReferences: z.object({
        pageInfo: page,
        nodes: z.array(z.object({ number: z.number(), body: z.string() })),
      }),
      files: z.object({ pageInfo: page, nodes: z.array(z.object({ path: z.string() })) }),
      commits: z.object({ pageInfo: page, nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) })) }),
      head: z.object({
        nodes: z.array(
          z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) }),
        ),
      }),
      comments: z.object({ pageInfo: page, nodes: z.array(comment) }),
      reviews: z.object({ pageInfo: page, nodes: z.array(comment) }),
      reviewThreads: z.object({
        pageInfo: page,
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            path: z.string(),
            comments: z.object({ nodes: z.array(comment) }),
          }),
        ),
      }),
    }),
  }),
})

type PullRequest = z.infer<typeof pullRequestSchema>['repository']['pullRequest']

/** The repository `gh` works on here, as its owner and name. */
function repository(): { owner: string; name: string } {
  const [owner, name] = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim().split('/')
  if (owner === undefined || name === undefined) throw new Error('gh repo view did not name a repository.')
  return { owner, name }
}

function pullRequest(number: number): PullRequest {
  return graphql(PULL_REQUEST, { ...repository(), number }, pullRequestSchema).repository.pullRequest
}

/** The workflow of the Claude review. */
const REVIEW_WORKFLOW = '.github/workflows/claude-review.yml'

/** The Claude review's account, as GraphQL and the REST API name it. */
const CLAUDE = /^claude(\[bot\])?$/

/** Commits named in text: 7 to 40 hex digits with at least one digit and one letter. */
function namedCommits(text: string): string[] {
  return [...text.matchAll(/\b[0-9a-f]{7,40}\b/g)]
    .map((match) => match[0])
    .filter((word) => /[0-9]/.test(word) && /[a-f]/.test(word))
}

/**
 * Whether GitHub has `commit`. A comment may well name a commit that is not on the PR's branch (the
 * `main` the rules were read from, say); what must not happen is a reply naming a fix that was
 * committed but never pushed, as on a detached HEAD.
 */
function pushed(owner: string, name: string, commit: string): boolean {
  try {
    execFileSync('gh', ['api', `repos/${owner}/${name}/commits/${commit}`, '--jq', '.sha'], { stdio: 'pipe' })
    return true
  } catch (error) {
    // Only GitHub saying it has no such commit means that; any other failure is not an answer.
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : ''
    if (/HTTP (404|422)/.test(stderr)) return false
    throw error
  }
}

/** What stops the PR from merging; empty when it can. */
function problems(pr: PullRequest, owner: string, name: string): string[] {
  const found: string[] = []
  const author = pr.author?.login
  const head = pr.headRefOid
  if (pr.state !== 'OPEN') found.push(`The PR is ${pr.state.toLowerCase()}.`)
  if (pr.isDraft) found.push('The PR is a draft.')
  if (pr.baseRefName !== 'main') {
    found.push(`The PR is based on ${pr.baseRefName}: it merges only once GitHub points it at main.`)
  }
  if (pr.autoMergeRequest !== null) {
    found.push(`Auto-merge is already on. Unless the user asked for it, undo it with gh pr merge --disable-auto.`)
  }

  const checks = pr.head.nodes[0]?.commit.statusCheckRollup?.state ?? 'none'
  if (checks !== 'SUCCESS') found.push(`The checks on the head commit are ${checks.toLowerCase()}, not all passed.`)

  const lists = [pr.comments, pr.reviews, pr.reviewThreads, pr.commits, pr.files, pr.closingIssuesReferences]
  if (lists.some((list) => list.pageInfo.hasNextPage)) {
    found.push(
      'The PR has more comments, reviews, threads, commits, files, or closed Issues than one read covers: check it by hand.',
    )
  }
  const open = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved)
  if (open.length > 0) {
    found.push(`${open.length} review thread(s) unresolved: ${open.map((thread) => thread.path).join(', ')}.`)
  }

  const checklists = [{ where: 'The PR body', body: pr.body }].concat(
    pr.closingIssuesReferences.nodes.map((issue) => ({ where: `Issue #${issue.number}`, body: issue.body })),
  )
  for (const { where, body } of checklists) {
    const unticked = body.split('\n').filter((line) => /^\s*[-*] \[ \]/.test(line))
    for (const line of unticked) found.push(`${where} has an unticked item: ${line.trim()}`)
  }

  const commits = pr.commits.nodes.map((node) => node.commit.oid)
  const short = head.slice(0, 7)
  const authorReviews = pr.reviews.nodes.filter((review) => review.author?.login === author)
  // claude-code-action refuses to run when the PR changes its own workflow, and the check still
  // passes: such a PR has only the full review, so that review must have seen the head.
  if (pr.files.nodes.some((file) => file.path === REVIEW_WORKFLOW)) {
    const latest = authorReviews.at(-1)
    if (latest === undefined || !namedCommits(latest.body).some((c) => head.startsWith(c))) {
      found.push(
        `The PR changes ${REVIEW_WORKFLOW}, so the full review is its only one, and the latest review by ${author ?? 'the PR author'} does not name the head commit ${short}: review the head.`,
      )
    }
  } else {
    const claude = pr.comments.nodes.filter((c) => CLAUDE.test(c.author?.login ?? '')).at(-1)
    if (claude === undefined) found.push('The Claude review has posted no summary comment.')
    else if (!claude.body.includes(short)) {
      found.push(`The latest Claude review summary does not name the head commit ${short}.`)
    }
    const fullReview = authorReviews.some((review) =>
      namedCommits(review.body).some((c) => commits.some((oid) => oid.startsWith(c))),
    )
    if (!fullReview) {
      found.push(`No review by ${author ?? 'the PR author'} names a commit of the PR: the full review is missing.`)
    }
  }

  const byAuthor = [
    ...pr.comments.nodes,
    ...pr.reviews.nodes,
    ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
  ]
    .filter((c) => c.author?.login === author)
    .flatMap((c) => namedCommits(c.body))
  const unknown = [...new Set(byAuthor)].filter((c) => !commits.some((oid) => oid.startsWith(c)))
  for (const commit of unknown) {
    if (!pushed(owner, name, commit)) found.push(`A comment names ${commit}, which GitHub doesn't have: was it pushed?`)
  }
  return found
}

function ready(number: number): number {
  const { owner, name } = repository()
  const pr = pullRequest(number)
  const found = problems(pr, owner, name)
  if (found.length > 0) {
    console.log(`PR ${number} is not ready to merge:`)
    for (const problem of found) console.log(`- ${problem}`)
    return 1
  }
  console.log(`PR ${number} is ready to merge. If it changes what the user sees, its demo recording is posted.`)
  if (pr.files.nodes.some((file) => file.path === REVIEW_WORKFLOW)) {
    console.log(
      `It changes ${REVIEW_WORKFLOW}, so the Claude review did not run on it: the full review is its only one.`,
    )
  }
  console.log('Merge only when the user asks:')
  console.log(`  gh pr merge ${number} --match-head-commit ${pr.headRefOid}`)
  return 0
}

const RESOLVE = `
mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
}`

function resolve(number: number): number {
  const pr = pullRequest(number)
  const author = pr.author?.login
  const open = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved)
  // A user's call stays open until the user decides it, whoever replied last.
  const answered = open.filter(
    (thread) =>
      thread.comments.nodes.at(-1)?.author?.login === author &&
      !/^\s*\*\*User's call/.test(thread.comments.nodes[0]?.body ?? ''),
  )
  for (const thread of answered) {
    graphql(RESOLVE, { thread: thread.id }, z.unknown())
    console.log(`Resolved the thread on ${thread.path}.`)
  }
  const left = open.length - answered.length
  if (left > 0)
    console.log(
      `${left} thread(s) left open: a user's call, or a thread whose last comment is not a reply from ${author ?? 'the PR author'}.`,
    )
  return left > 0 ? 1 : 0
}

function main(args: readonly string[]): number {
  const [command, pr] = args
  const number = Number(pr)
  if (!Number.isInteger(number) || number <= 0) throw new ArgumentError('Usage: pnpm pr <ready|resolve> <pr-number>')
  if (command === 'ready') return ready(number)
  if (command === 'resolve') return resolve(number)
  throw new ArgumentError(`Unknown command ${command ?? ''}. Usage: pnpm pr <ready|resolve> <pr-number>`)
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof ArgumentError)) throw error
  console.error(error.message)
  process.exitCode = 2
}
