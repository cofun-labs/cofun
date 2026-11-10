# notion-copilot

Copilot for Notion: a Chrome extension that opens an AI side panel next to Notion pages, backed by a Cloudflare Worker.

**Before starting work, read [README.md](README.md)** for the architecture, auth flow, and setup. This file covers the development workflow and coding conventions.

## Workflow

**Always use `pnpm`** (never `npm` or `yarn`). **Always use the `gh` CLI** for GitHub operations: issues, labels, pull requests, checks, comments, and reviews.

**All changes follow the BDD workflow (see [docs/bdd.md](docs/bdd.md)) and are usually issue-driven:**

1. **Create an Issue first**, unless the user explicitly asks you to open a PR directly; then skip the Issue and put its Goal, Approach, and Checklist in the PR body instead. Add a priority label and describe:
   - Priority: `P0` (must do now), `P1` (should do soon), `P2` (can wait), or `later` (for Issues only; use case scenarios keep P0/P1/P2, see [docs/bdd.md](docs/bdd.md)). A `later` issue is only recorded and is not developed until it is re-prioritized. Use `later` for work whose value is low for its cost now, or that would add more complexity than the product needs.
   - Goal: the problem being solved or the feature being added
   - Approach: how it will be implemented
   - This checklist, which must be complete before merge:

     ```markdown
     ## Checklist

     - [ ] Use cases and tests updated
     - [ ] CI passes
     - [ ] Sub-agent review submitted on PR
     - [ ] All PR comments resolved
     ```

2. **Update use cases before writing code**, only when the product behavior contract changes (see [docs/bdd.md](docs/bdd.md) for what belongs in a use case). In `docs/use-cases/{domain}/`:
   - Reuse an existing use case or scenario when it already expresses the contract. Bug fixes and refactors usually change no use case.
   - Edit the Behavior, add or remove scenarios, or merge/split use cases. Reuse a scenario ID only for wording changes; changed behavior gets a new ID.
   - Give each scenario a priority (P0/P1/P2), put it under its strategy (`api-test` or `ai-e2e`), and set its status (🚧 until verified, then ✅).

3. **Implement with tests.** Keep tests in sync with use cases:
   - Remove tests for deleted scenarios, add tests for new ones, rename tests when scenario IDs change.
   - P0 scenarios must be verified before merge; P1 should be; P2 can wait.
   - `api-test` scenarios are vitest integration tests in `worker/test/`, named with the scenario ID. `ai-e2e` scenarios are verified by an agent driving a real browser with `pnpm e2e`, and the run is recorded in the PR (see [Running an `ai-e2e` scenario](docs/bdd.md#running-an-ai-e2e-scenario)).
     ```typescript
     it('[UC-CHAT-001-S01] signed-in user gets a streamed reply', async () => {
     ```
   - Implementation details worth guarding (status codes, CORS, config errors, regressions) get standalone tests without a scenario ID.

4. **Run pre-PR checks.** Run `pnpm check`, then review `git diff --stat origin/main...` and `git diff origin/main... -- docs/use-cases`. Confirm the diff matches the Issue (or the PR body, when there is no Issue) and no BDD updates are missing.

5. **Open a PR.** Branch `issue-{ID}` from `origin/main` (or a short descriptive name when there is no Issue), commit, push, and open a PR. If there is an Issue, the PR body contains `Closes #{ID}`.

6. **Wait for checks.** If a check fails, fix it, push to the same branch, and wait again until all checks pass.

7. **Review the PR.** Once CI passes, **always spawn a sub-agent** for an independent review (it must not carry the implementation context). The sub-agent:
   - Reads the Issue (if any) and PR descriptions
   - Verifies every requirement in the Issue or PR body is implemented
   - Verifies the diff matches the BDD scenarios, every `api-test` scenario has a test, and no implementation details were written into use cases
   - Confirms there are no unrelated changes
   - Judges whether the approach is correct and reasonable
   - Submits the review with `gh pr review --comment` (GitHub blocks approving your own PR)

8. **Handle PR comments.** Fix every blocking comment the PR brings in, or show with evidence that it isn't a real problem. A comment is blocking when it is a user-visible bug, data loss, a risk to the user's Notion account (see "Calling Notion" below), any other security problem (a committed secret or account identifier included), a failing check, or a breach of a rule this file says must hold (step 7's checks and verifying P0 scenarios included). A change the user or a maintainer explicitly asks for is always blocking; only bot and sub-agent review comments can be suggestions. Other comments are suggestions: answer each with a short reason, for example that it isn't blocking and isn't worth another round of CI and review, and resolve it without pushing, since every push restarts both. Trivial suggestions may ride along with a push you make anyway. A blocking problem the PR didn't bring in gets a follow-up Issue (`P0` to `P2`, never `later`) instead of a fix here. A suggestion worth recording gets a `later` Issue; otherwise answering it in the thread is enough. Push fixes to the same branch and reply to each comment with the fix commit, the verification, or the follow-up Issue. Then resolve each review thread: GitHub blocks merging until every thread is resolved. `gh` has no command for it, so use `gh api graphql` with the `resolveReviewThread` mutation, or the web UI.

9. **Hand off for merge.** Check that every checklist item in the Issue or PR body is done, then tell the user the PR is ready to merge. **Never merge a PR on your own**, and never enable auto-merge. Only when the user explicitly asks, run `gh pr merge {PR}`. `main` uses a merge queue: this adds the PR to the queue, which runs CI again on top of the latest `main` and squash-merges it if CI passes. Wait until the PR shows as merged; if the queue removes it, fix the failure and tell the user before queueing it again. GitHub deletes the branch, and `Closes #ID` closes the Issue, if there is one.

10. **Wait for the deploy.** Once the queue merges the PR, the push to `main` triggers Cloudflare Workers Builds, which runs the worker tests and deploys the worker. The work is done only when that deploy succeeds; if it fails, fix it right away.

**Trivial changes** (typos, dependency bumps, config tweaks) may skip the BDD steps but still go through a branch and PR.

### Git rules

- **Never push to `main`.** Every change goes through a branch and PR. The `main` ruleset (`.github/rulesets/main.json`) makes GitHub reject direct pushes to `main` from everyone.
- **GitHub settings are code.** The `main` ruleset lives in `.github/rulesets/main.json` and repository options in `scripts/sync-github-settings.sh`. Change them through a PR; a repository admin then runs `scripts/sync-github-settings.sh`. If you change a setting in the GitHub dashboard, copy it back into these files.
- **Never rewrite published history** (`git commit --amend`, `git rebase`) on pushed branches. Add new commits instead.
- **Never force-push** unless explicitly asked.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commits and PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

## Language

**Everything is in English:** code, comments, docs, commit messages, issues, PRs, and API error messages.

## Public repository

This is an open-source repository. **Never commit account identifiers or secrets**: Cloudflare account IDs, API tokens, Clerk secret keys, or the extension's private signing key (`extension/keys/`, git-ignored). Values that are public by design are fine: the Clerk publishable key, the Clerk JWT public key, the extension's public key and ID, and domain names.

## Architecture

- `extension/`: Chrome MV3 side panel. Vite + React + TypeScript. Clerk sign-in through Sync Host. `vite.config.ts` generates `manifest.json` from `.env`. The agent loop runs in the side panel on `@earendil-works/pi-agent-core`; only `src/agent.ts` imports pi, and tools live in `src/tools.ts`.
- `worker/`: Cloudflare Worker with Hono. Serves `/login`, verifies Clerk session JWTs locally, and proxies OpenAI-compatible `/v1/chat/completions` to Workers AI through AI Gateway.
- Notion tools call Notion's own internal endpoints (`/api/v3/…`) as the signed-in Notion user, through `src/notion/api.ts`: the only module that knows Notion's endpoints and request shapes. Requests run inside the user's Notion tab (`src/notion/tab.ts`, `chrome.scripting` in the ISOLATED world), so they go to that tab's own host with its session. Tools never `fetch` Notion URLs themselves. Do not use `chrome.debugger`: it shows a permanent "debugging this browser" banner.

## Calling Notion: stop, don't work around

Tools call Notion's internal API as the user's own account, so **stability comes first**: Notion must never see this extension as automated abuse. Every Notion feature follows these rules:

- **Retry only when it is clearly safe and would fix the problem.** A retry must not be able to apply a change twice, and the cause must be one a retry can fix. When in doubt, don't retry: safety first. Never fall back to another endpoint or another way of getting the same result.
- **Stop on what we don't understand.** A failure we can't identify, or a response we didn't expect, stops the work and is reported. Don't guess a workaround.
- **Rate limits stop the question, with no retry.** When Notion turns a request away (429, or 529), the client sends nothing more, the agent ends the question, and the user is told to wait. A tool error does this by carrying `stopsQuestion` (see `NotionError` in `src/notion/api.ts`). Code that catches Notion errors must rethrow one that carries `stopsQuestion`, never swallow it. A tool that changes the user's data sets `changesData` (see `ToolSpec` in `src/agent.ts`), and an error after a change that may have landed sets `mayHaveChanged`, so a question that stops tells the user to check before asking again.
- Handle only failures whose meaning is known, such as signed out, no access, or a page that changed since it was read.

## Testing

- Backend tests are REST integration tests: they call the Hono app over HTTP and assert on status codes and JSON bodies.
- **No mocking.** Do not use `vi.mock()` or spies. Replace external dependencies with fake objects that implement the same interface, and inject them through `env`:
  - `FakeAiBinding` (`worker/test/fakes.ts`) stands in for the Workers AI binding.
  - `FakeClerk` (`worker/test/clerk.ts`) signs real RS256 session tokens with a local key pair, which the worker verifies like real Clerk tokens.
- `worker/test/extension.test.ts` runs the extension's own agent (`src/agent.ts`) against the worker so client and server cannot drift.

## Commands

```bash
pnpm install
pnpm check        # lint, format check, typecheck, extension build, worker and e2e tool tests
pnpm format:fix   # format all files
pnpm test         # worker tests and the e2e tool's unit tests
pnpm build        # build the extension into extension/dist
pnpm e2e --help   # drive the shared Chrome Canary for ai-e2e runs (maintainer's machine only)
```

## Key decisions

- **No backward compatibility.** Pick the cleanest solution; delete old code instead of deprecating it.
- **TypeScript everywhere.**
- **The worker fixes the model.** Clients cannot choose another model.
