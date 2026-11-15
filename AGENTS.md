# Cofun

Cofun: Chrome extensions that each open an AI side panel next to one kind of page, backed by one Cloudflare Worker they share. The repository holds the extensions, one per folder in `extensions/` (Notico, for Notion, in `extensions/notico/`), and the worker. This file covers the development workflow and coding conventions.

**Before starting work, read [docs/architecture.md](docs/architecture.md)** for the architecture, auth flow, and code layout. The other docs:

- [docs/development.md](docs/development.md): setup, testing infrastructure, merging, and deployment.
- [docs/release.md](docs/release.md): releasing an extension to the Chrome Web Store.
- [docs/security.md](docs/security.md): the security model, which a change to the agent, the extension's surface, or the worker's routes is checked against.
- [docs/bdd.md](docs/bdd.md): use cases, scenarios, and what gets a test.
- [docs/review.md](docs/review.md): how a PR is reviewed, with every rule numbered.
- [README.md](README.md) introduces Cofun; each `extensions/<name>/README.md` is written for that extension's users, with little technical detail.

Update `docs/architecture.md` only when a change adds, moves, or removes a module boundary or anything its Layout lists, or changes where data goes or comes from (a new host, store, or route). Limits, constants, index names, UI details, and edge-case behavior go in code comments.

## Workflow

**Always use `pnpm`** (never `npm` or `yarn`). **Always use the `gh` CLI** for GitHub operations: issues, labels, pull requests, checks, comments, and reviews.

1. **Create an Issue first for a change to product behavior or work spanning several PRs.** Anything else goes straight to a PR, with its Goal, Approach, and Checklist in the PR body. An Issue has:
   - A priority label: `P0` (must do now), `P1` (should do soon), `P2` (can wait), or `later`. A `later` Issue is only recorded, and is not developed until it is re-prioritized: use it for work whose value is low for its cost now, or that would add more complexity than the product needs. (Use case scenarios keep P0/P1/P2; see [docs/bdd.md](docs/bdd.md).)
   - Goal: the problem being solved or the feature being added.
   - Approach: how it will be implemented.
   - This checklist, which must be complete before merge:

     ```markdown
     ## Checklist

     - [ ] Business rules covered by scenarios and tests (or none changed)
     ```

2. **Cover business rules with scenarios.** Ask one question: does this change add or change a business rule a user can notice? If not, as with most bug fixes and refactors, no use case changes. If so:
   - A scenario covers it, in `extensions/<name>/use-cases/{domain}/`, or in `worker/use-cases/{domain}/` for a rule only the worker decides ([Products](docs/bdd.md#products)).
   - Reuse or edit a scenario that already says it, or add one with a priority (P0/P1/P2) under its strategy (`api-test` or `ai-e2e`), marked 🚧 until verified, then ✅. [docs/bdd.md](docs/bdd.md) says how to write them.

3. **Implement with tests.** A test guards each such rule:
   - P0 scenarios must be verified before merge; P1 should be; P2 can wait.
   - `api-test` scenarios are vitest integration tests named with the scenario ID: in `worker/test/` for the worker's HTTP API, and in `extensions/<name>/test/` for the extension's client code (`*.test.ts`) and the side panel's UI (`*.test.tsx`).
     ```typescript
     it('[UC-NOTICO-CHAT-001-S01] signed-in user gets a streamed reply', async () => {
     ```
   - `ai-e2e` scenarios are verified by an agent driving a real browser with `pnpm e2e`, and the run is recorded in the PR ([Running an `ai-e2e` scenario](docs/bdd.md#running-an-ai-e2e-scenario)).
   - Implementation details worth guarding get standalone tests named with `[@no-uc:<kind>]` for the harm they guard (`data`, `notion-safety`, `money`, `access`, `privacy`, or `contract`; see [What gets a test](docs/bdd.md#what-gets-a-test)).
   - `pnpm check` fails on a test that names neither a scenario ID nor a kind, on an `api-test` scenario marked ✅ with no test named with its ID, and on a scenario row it can't read ([Coverage check](docs/bdd.md#coverage-check)). When a scenario's ID changes, rename its tests; when a scenario is deleted, delete its tests or take the ID out of their names.
   - Gaps that slip past a PR are found by the `/bdd-audit` skill, run before a release or after a large feature ([Coverage audit](docs/bdd.md#coverage-audit)), not by per-PR bookkeeping.

4. **Run pre-PR checks.** `pnpm check` runs on every commit (a lefthook pre-commit hook). Review `git diff --stat origin/main...` and `git diff origin/main... -- 'extensions/*/use-cases/*' worker/use-cases`. Confirm the diff matches the Issue (or the PR body, when there is no Issue) and every business rule it adds or changes has a scenario and a test.

5. **Open a PR.** Branch `issue-{ID}` from `origin/main` (or a short descriptive name when there is no Issue), commit, push, and open a PR. If there is an Issue, the PR body contains `Closes #{ID}`.
   - A branch builds on another unmerged PR only when it needs that PR's changes; its PR targets that branch as its base, so its diff and review cover only its own commits. Such a PR is never merged while its base is not `main`: once its base merges, GitHub points it at `main`, and it merges `origin/main` and goes through the queue like any other.
   - Otherwise merge `origin/main` into a PR's branch only when the PR conflicts with `main` or needs a change from it: the merge queue already runs CI on top of the latest `main`, and every push restarts CI and review.

6. **Wait for checks.** If a check fails, fix it, push to the same branch, and wait again until all checks pass.

7. **Review the PR.** The on-push review (`.github/workflows/on-push-review.yml`, run by Claude on GitHub Actions) comments on every push; its comments are handled in step 8.
   - **Once the PR is ready** (CI passes, the on-push review's comments are handled, and nothing more is planned), spawn a sub-agent for a full review and give it the PR number and [docs/review.md](docs/review.md). **Always spawn it fresh**, never as a fork of the session that wrote the PR.
   - A fix after the full review is checked by the next on-push review; run the full review again only if a fix changes the PR's approach.
   - A review that was dispatched, or a review workflow that was triggered, is not evidence that a review finished or found nothing: read the review that was submitted.

8. **Handle PR comments.** Findings are **Blocking**, **User's call**, **Suggestion**, or **Follow-up**, as [docs/review.md](docs/review.md#how-to-report-a-finding) defines them. A change the user or a maintainer explicitly asks for is always blocking; comments from anyone else, bots and sub-agents included, are judged by those definitions.
   - **Blocking:** fix it, or show with evidence that it isn't a real problem. A problem the PR didn't bring in, or an edge case in behavior it did not set out to change, is a Follow-up instead; a bug in what the PR adds is fixed here.
   - **Follow-up:** open an Issue for it: `P0` to `P2` when it would be Blocking (by its rule's weight, or by one of the harms in [docs/review.md](docs/review.md#how-to-report-a-finding)), and `later` allowed otherwise. A usable weakness (D10) never goes into an Issue: it goes to a private report ([SECURITY.md](SECURITY.md)).
   - **User's call:** hand it to the user with what they would lose, and push neither way until they decide.
   - **Suggestion:** answer with a short reason (for example, that it isn't worth another round of CI and review) and resolve it without pushing, since every push restarts both. A trivial one may ride along with a push you make anyway; one worth recording gets a `later` Issue.
   - Reply to each comment with the fix commit, the verification, or the follow-up Issue. Before a reply names a fix commit, check that the PR has it (`gh pr view {PR} --json commits`).
   - Resolve each answered thread ([Merging](docs/development.md#merging)): GitHub blocks merging until every thread is resolved.
   - If pushes to fix review comments draw new blocking comments more than three times in a row, stop pushing and hand the open list to the user.

9. **Hand off for merge.**
   - **A PR that changes what the user sees** is ready only once a GIF (or screenshots) of the finished feature, recorded after the full review, is posted as a PR comment and shown to the user ([PR media](docs/development.md#pr-media)). Record it in a test workspace, with no real page content or account details in view, and never push media to a git branch.
   - **Check readiness**: every check has passed, every review thread is resolved, every checklist item in the Issue or PR body is ticked, and a review covers the head. Then tell the user the PR is ready to merge.
   - **Never merge a PR on your own.** Only when the user explicitly asks, and only once the PR is ready, run `gh pr merge {PR} --match-head-commit {SHA}` with the head commit that was reviewed (or a merge of `origin/main` on top of it with no conflict resolved by hand). It adds the PR to the merge queue ([Merging](docs/development.md#merging)).
   - **Never enable auto-merge on a PR that is not ready**, by this command or any other route: it would merge by itself once ready, later pushes included. If it was enabled early, undo it with `gh pr merge {PR} --disable-auto` and tell the user.
   - Push every fix before queueing: GitHub rejects pushes to a queued PR's branch, so a fix found later goes into a follow-up PR. Wait until the PR shows as merged; if the queue removes it, fix the failure and tell the user before queueing it again.

### Git rules

- **Never push to `main`.** Every change goes through a branch and PR; the `main` ruleset (`.github/rulesets/main.json`) rejects direct pushes from everyone.
- **Work in a worktree.** Develop each task in its own git worktree under `.claude/worktrees/`, branched from `origin/main`. Leave the main checkout on `main`: the maintainer reads code and runs `pnpm build` and `pnpm e2e` there.
- **GitHub settings are code**: the `main` ruleset in `.github/rulesets/main.json`, repository options in `scripts/sync-github-settings.sh`. Change them through a PR ([GitHub settings](docs/development.md#github-settings)).
- **Never rewrite published history** (`git commit --amend`, `git rebase`) on pushed branches; add new commits. **Never force-push** unless explicitly asked.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commits, PR titles, and Issue titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. The prefix is an Issue's kind: there are no type labels.

## Language

**Everything is in English:** code, comments, docs, commit messages, issues, PRs, and API error messages.

## Public repository

This is an open-source repository. **Never commit account identifiers or secrets**: Cloudflare account IDs, API tokens, Clerk secret keys, or an extension's private signing key (`extensions/<name>/keys/`, git-ignored). Values that are public by design are fine: the Clerk publishable key, the Clerk JWT public key, the extension's public key and ID, and domain names.

## Privacy

An extension's Chrome Web Store privacy policy is written in two parts: [PRIVACY.md](PRIVACY.md) for what is the same for every extension (the sign-in, and what the worker receives, stores, and logs), and `extensions/<name>/PRIVACY.md` ([Notico's](extensions/notico/PRIVACY.md)) for what that extension reads in the browser, which hosts it sends data to, and what it keeps on the device.

**A change to what data leaves the browser, or to where it goes, updates the privacy page it concerns in the same PR:**

- New data sent to a host, or a new host, updates the extension's `PRIVACY.md`. Its table of hosts is the list of hosts the extension may contact.
- A new host also changes the content security policy (`extensions/notico/manifest.ts`), which enforces that list for the extension's pages, and `extensions/notico/test/manifest.test.ts`, which pins the policy and the host permissions.
- A change to what the worker stores or logs updates `PRIVACY.md`.
- What the Chrome Web Store asks about the same things (permission justifications, data usage) is in `extensions/<name>/store/privacy.md`, which changes with them.

## Architecture

[docs/architecture.md](docs/architecture.md) describes the design; these are the rules a change must keep.

- **One extension per folder.** Each extension keeps its own copy of the side panel code and never imports another extension.
- **A site is called only through its site layer**: one module knows the site's endpoints and request shapes (Notico's `src/notion/api.ts`), and requests run inside the user's tab for that site (`src/<site>/tab.ts`, `chrome.scripting` in the ISOLATED world), so they go to that tab's host with its session. Tools never `fetch` the site's URLs themselves. Never use `chrome.debugger`: it shows a permanent "debugging this browser" banner.
- **Every worker route under `/v1` sits behind the session check** (`src/routes/session.ts`); `worker/test/session.test.ts` checks that each refuses a request without a session.
- **Module boundaries are lint errors** in `.oxlintrc.json`, run by `pnpm check`. In every extension:
  - only `src/agent/` imports pi (`@earendil-works/pi-agent-core`);
  - `fetch` is used only in `src/<site>/tab.ts` (the site) and `src/agent/` (the worker); `chrome.scripting` only in `src/<site>/tab.ts`; `chrome.debugger` nowhere;
  - `zod` is imported only through `src/zod.ts` (the worker's through `worker/src/zod.ts`);
  - `posthog-js` is imported only in `src/analytics.ts`;
  - the site layer imports nothing from the agent, the tools, the sessions, or the side panel;
  - no extension imports another.

  When a boundary changes, change the rule and this list together. Never silence one with an `oxlint-disable` comment.

## Untrusted values

A value the code does not control is `unknown` until it is validated where it arrives: what the model sends, what Notion answers, the body of a network request or response, and what is read back from storage. **Never give such a value a type with a type assertion (`as`).** Parse it with a zod schema and use the type the schema gives.

- One schema is the single source: the type, the runtime check, and any description of the shape given to someone else (such as a tool's JSON Schema) all come from it.
- Validate at the boundary, and only there: code behind it takes the parsed type and does not check again.
- A value that fails says what is wrong, specifically enough for whoever sent it to correct it.
- The one exception: a Notion database's property definitions and the runs and marks of rich text are read where they are used, with checks written by hand ([F5](docs/review.md#f-untrusted-values)). New code that reads them asserts nothing wider than it checked.

## Usage data: never content

An extension sends product analytics to PostHog only through `src/analytics.ts`, whose `track` takes a fixed list of events ([Usage data](docs/architecture.md#usage-data)).

- **An event never holds content**: nothing the user or the model wrote, nothing from a page (its content, title, or URL), and no key.
- Every property is an enum, a number, or a boolean, checked by the event's schema before it is sent. A value from the model or a service (a tool's name, an error code) is sent only when it is on a fixed list.
- A new event or property is added to the schema, to the list of properties the module keeps, and to the extension's `PRIVACY.md` in the same PR.
- Never turn on autocapture, session replay, or exception capture: each would send text from the panel.

## Calling a site as the user: stop, don't work around

An extension's tools call its site's own API, often an internal one, as the user's own account, through the site layer (`src/<site>/`). So **stability comes first**: the site must never see the extension as automated abuse, since a mistake lands on the user's account. These rules hold for every site; how Notico keeps them for Notion is in [review rules E](docs/review.md#e-calling-a-site-as-the-user).

- **Retry only when it is clearly safe and would fix the problem**: a retry must not be able to apply a change twice, and the cause must be one a retry can fix. When in doubt, don't. Never fall back to another endpoint or another way of getting the same result.
- **Stop on what we don't understand.** A failure we can't identify, or a response we didn't expect, stops the question and is reported to the user; don't guess a workaround. Give a failure a code of its own only when its meaning is known and the model can act on it, and throw a plain error for bad input from the model.
- **Rate limits stop the question, with no retry.** When the site turns a request away for coming too fast, the client sends nothing more, the agent ends the question, and the user is told to wait. A tool error does this by carrying `stopsQuestion` (read by `src/agent/calls.ts`); code that catches the site's errors must rethrow one that carries it, never swallow it.
- **A tool that changes the user's data sets `changesData`** (see `ToolSpec` in `src/agent/types.ts`), and an error after a change that may have landed sets `mayHaveChanged`, so a question that stops tells the user to check before asking again.
- Handle only failures whose meaning is known, such as signed out, no access, or a page that changed since it was read.

## Testing

How the fakes and test helpers fit together is in [Testing](docs/development.md#testing).

- **Write a test only when it earns its place.** More tests are not better: each one costs time to run, read, and change. [What gets a test](docs/bdd.md#what-gets-a-test) decides.
- **Tests live with the package they cover**: `extensions/<name>/test/` and `worker/test/`. Backend tests are REST integration tests that call the Hono app over HTTP and assert on status codes and JSON bodies.
- **No mocking.** No `vi.mock()` and no spies. Replace an external dependency with a fake that implements the same interface, injected through `env`. The one module replaced whole is Clerk's React SDK, for the UI tests only; replace no other module this way.
- **UI tests run the whole side panel and act as a user** ([Testing the side panel's UI](docs/bdd.md#testing-the-side-panels-ui)). Never test a component on its own, and find things by role, accessible name, or visible text, never through component state, the agent, the session store, or a test id. If an element can't be found that way, improve its accessibility.
- **Tests never wait for time to pass.** Use a fake clock with an explicit start time and move it: no sleeps, and no assertion that depends on how long something took. Waiting for the screen to change is fine.

## Commands

The full list is in [docs/development.md](docs/development.md).

```bash
pnpm check        # lint, knip, format check, use case coverage, typecheck, extension build, and every package's tests
pnpm format:fix   # format all files
pnpm test         # extension and worker tests, and the unit tests of scripts/
pnpm media 367 demo.gif   # upload a PR's demo GIF or screenshots and print their URLs (maintainer's machine only)
pnpm e2e --help   # drive the shared Chrome Canary for ai-e2e runs (maintainer's machine only)
```

## Key decisions

- **No backward compatibility.** Pick the cleanest solution; delete old code instead of deprecating it.
  - The one exception is the worker's API as the published extensions use it. The worker deploys as soon as a PR merges, but installed extensions update only after a Chrome Web Store review, so the worker keeps accepting what the extension version on the store sends and answering in a shape it parses. Keep what an older build needs with a comment saying when it can go, and a `[@no-uc:contract]` test that pins it.
  - `pnpm knip` fails on unused files, exports, and dependencies: delete what it finds. List something in `knip.jsonc` only when it is a false positive or kept on purpose, with the reason.
- **The worker fixes the hosted model.** Clients cannot make the worker use another model. A user's own model (OpenRouter, with their key) is asked from the extension directly, never through the worker.
