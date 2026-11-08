# notion-copilot

Copilot for Notion: a Chrome extension that opens an AI side panel next to Notion pages, backed by a Cloudflare Worker.

**Before starting work, read [README.md](README.md)** for the architecture, auth flow, and setup. This file covers the development workflow and coding conventions.

## Workflow

**Always use `pnpm`** (never `npm` or `yarn`). **Always use the `gh` CLI** for GitHub operations: issues, labels, pull requests, checks, comments, and reviews.

**All changes are issue-driven and follow the BDD workflow (see [docs/bdd.md](docs/bdd.md)):**

1. **Create an Issue first.** Add a priority label (`P0`, `P1`, or `P2`) and describe:
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
   - `api-test` scenarios are vitest integration tests in `worker/test/`, named with the scenario ID. `ai-e2e` scenarios are verified by an agent driving a real browser, and the run is recorded in the PR.
     ```typescript
     it('[UC-CHAT-001-S01] signed-in user gets a streamed reply', async () => {
     ```
   - Implementation details worth guarding (status codes, CORS, config errors, regressions) get standalone tests without a scenario ID.

4. **Run pre-PR checks.** Run `pnpm check`, then review `git diff --stat origin/main...` and `git diff origin/main... -- docs/use-cases`. Confirm the diff matches the Issue and no BDD updates are missing.

5. **Open a PR.** Branch `issue-{ID}` from `origin/main`, commit, push, and open a PR whose body contains `Closes #{ID}`.

6. **Wait for checks.** If a check fails, fix it, push to the same branch, and wait again until all checks pass.

7. **Review the PR.** Once CI passes, **always spawn a sub-agent** for an independent review (it must not carry the implementation context). The sub-agent:
   - Reads the Issue and PR descriptions
   - Verifies every requirement in the Issue is implemented
   - Verifies the diff matches the BDD scenarios, every `api-test` scenario has a test, and no implementation details were written into use cases
   - Confirms there are no unrelated changes
   - Judges whether the approach is correct and reasonable
   - Submits the review with `gh pr review --comment` (GitHub blocks approving your own PR)

8. **Handle PR comments.** Fix every blocking comment or answer it with a clear reason no change is needed. Non-blocking suggestions can be fixed now or turned into a follow-up Issue. Push fixes to the same branch and reply to each comment with the fix commit, the verification, or the follow-up Issue. Then resolve each review thread: GitHub blocks merging until every thread is resolved. `gh` has no command for it, so use `gh api graphql` with the `resolveReviewThread` mutation, or the web UI.

9. **Merge.** Check that every Issue checklist item is done, then run `gh pr merge {PR}`. `main` uses a merge queue: this adds the PR to the queue, which runs CI again on top of the latest `main` and squash-merges it if CI passes. Wait until the PR shows as merged; if the queue removes it, fix the failure and queue it again. GitHub deletes the branch, and `Closes #ID` closes the Issue.

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

- `extension/`: Chrome MV3 side panel. Vite + React + TypeScript. Clerk sign-in through Sync Host. `vite.config.ts` generates `manifest.json` from `.env`.
- `worker/`: Cloudflare Worker with Hono. Serves `/login`, verifies Clerk session JWTs locally, and proxies OpenAI-compatible `/v1/chat/completions` to Workers AI through AI Gateway.
- Notion page reading and editing (planned) will call Notion's own internal endpoints from the page (`/api/v3/loadPageChunk`, `/api/v3/saveTransactionsFanout`). Do not use `chrome.debugger`: it shows a permanent "debugging this browser" banner.

## Testing

- Backend tests are REST integration tests: they call the Hono app over HTTP and assert on status codes and JSON bodies.
- **No mocking.** Do not use `vi.mock()` or spies. Replace external dependencies with fake objects that implement the same interface, and inject them through `env`:
  - `FakeAiBinding` (`worker/test/fakes.ts`) stands in for the Workers AI binding.
  - `FakeClerk` (`worker/test/clerk.ts`) signs real RS256 session tokens with a local key pair, which the worker verifies like real Clerk tokens.
- `worker/test/extension.test.ts` runs the extension's own `src/llm.ts` against the worker so client and server cannot drift.

## Commands

```bash
pnpm install
pnpm check        # lint, format check, typecheck, extension build, worker tests
pnpm format:fix   # format all files
pnpm test         # worker tests only
pnpm build        # build the extension into extension/dist
```

## Key decisions

- **No backward compatibility.** Pick the cleanest solution; delete old code instead of deprecating it.
- **TypeScript everywhere.**
- **The worker fixes the model.** Clients cannot choose another model.
