# Development

Requires Node.js 24 and pnpm. The repository is one pnpm workspace: the [worker](#worker), shared by every extension, and one folder per extension in `extensions/` ([Notico](#notico) is the first). The commands below cover all of them.

```bash
pnpm install
pnpm check        # lint, unused code check (knip), format check, use case coverage (pnpm use-cases), typecheck, extension build, and every package's tests
pnpm knip         # unused files, exports, and dependencies (knip.jsonc lists what is kept, and why)
pnpm use-cases    # every ✅ api-test scenario has a test; warns about other mismatches (docs/bdd.md)
pnpm format:fix   # format all files
pnpm test         # extension and worker tests, and the unit tests of scripts/
pnpm build        # build every extension into extensions/<name>/dist
pnpm test:browser # build the extensions and run their browser tests in Chromium (first: pnpm --filter notico-extension exec playwright install chromium)
pnpm icons        # export extensions/notico/icons/icon.svg into extensions/notico/public/icons (needs the same Chromium); commit the PNGs
pnpm media 367 demo.gif   # upload a PR's demo GIF or screenshots and print their URLs (maintainer's machine only; see PR media)
pnpm e2e --help   # drive the shared Chrome Canary for ai-e2e runs (maintainer's machine only)
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it and the browser tests on every pull request.

See [AGENTS.md](../AGENTS.md) for the issue → PR → review → merge workflow.

## GitHub settings

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, auto-merge allowed (on a branch with a merge queue, `gh pr merge` adds a PR to the queue through it), secret scanning with push protection, private vulnerability reporting (for [SECURITY.md](../SECURITY.md)), and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

A repository admin runs it from their machine with `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

## PR media

The GIF or screenshots that show a finished feature in a PR comment ([AGENTS.md](../AGENTS.md), step 9) are kept in the public R2 bucket `cofun-static`, served at `https://static.cofun.cc`, never on a git branch. Upload them and embed the URLs it prints as `![what it shows](<url>)` (GitHub shows only images that way; link to a video instead):

```bash
pnpm media 367 demo.gif before.png
# https://static.cofun.cc/cofun/pr/367/demo.gif
# https://static.cofun.cc/cofun/pr/367/before.png
```

Only the maintainer's machine can upload: the script runs the `cf` CLI with the Cloudflare login there (with several accounts in it, `CLOUDFLARE_ACCOUNT_ID` picks the one that has the bucket; don't commit it). Showcase GIFs meant for the README or an extension's help pages are committed in the repository instead.

## Testing

The rules for tests are in [AGENTS.md](../AGENTS.md#testing) and [docs/bdd.md](bdd.md#what-gets-a-test); this is how the pieces fit.

- **Fakes, injected through `env`:** `FakeAiBinding` (`worker/test/fakes.ts`) stands in for the Workers AI binding. `FakeClerk` (`worker/test/clerk.ts`) signs real RS256 session tokens with a local key pair, which the worker verifies like real Clerk tokens.
- **Clerk's React SDK** is the one module replaced whole: the side panel imports its components directly, so the extension's vitest config resolves `@clerk/chrome-extension` to `packages/cofun-app/test-support/clerk.tsx`, for the UI tests only.
- **Notion:** `extensions/notico/test/` tests Notico's client code against a fake Notion tab (`extensions/notico/test/notion-tab.ts`) that answers with sanitized fixtures (`extensions/notico/test/fixtures/notion/`).
- **Client and worker together:** Notico's client tests run its real agent against the real worker app (`createApp()` behind `fetch`), so the two cannot drift: the side panel's tests through `extensions/notico/test/panel.ts`, and the agent loop's rules in `extensions/notico/test/agent.test.ts`. `worker/test/extension.test.ts` keeps only what the two sides must agree on: the streamed reply, the tool-call round trip, sessions, credits, a question's cost, and a model change.
- **Browser tests** (`extensions/<name>/browser-test/`, `pnpm test:browser`, also in CI and before a release): Playwright loads the built extension into Chromium and checks, in Notico's (`extensions/notico/browser-test/`), that the service worker starts, the side panel is enabled on every tab, the side panel page renders signed out, and, with a signed-in Clerk session answered from fixtures, shows the chat, renders the model's streamed reply, and runs a Notion read and a trash that asks first through `chrome.scripting` in a real Notion tab. It catches builds that compile but break in Chrome, such as dependency bumps. Nothing leaves the machine: Notion pages and its API, Clerk's Frontend API, and the worker and its model are answered from `browser-test/fixtures/` and `browser-test/fakes.ts`. Its tests are standalone (no scenario IDs); what needs real Chrome or real accounts (the panel opening from the toolbar icon and staying open across tabs, Google sign-in, real Notion pages) stays `ai-e2e`.

## Merging

`gh` has no command to resolve a review thread; GraphQL does it, with the thread's ID from the pull request's `reviewThreads`:

```bash
gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }' -f id=PRRT_…
```

`main` uses a merge queue, and `gh pr merge {PR} --match-head-commit {SHA}` adds a PR to it through GitHub's auto-merge, which is why the repository allows auto-merge. `--match-head-commit` makes sure a commit pushed after the review can't ride along; the SHA is the reviewed head, or a merge of `origin/main` on top of it with no conflict resolved by hand. The command prints the same message ("will be added to the merge queue … when ready") whether it queued the PR or only armed auto-merge on a PR that isn't ready yet, so readiness is checked before it, not after. The queue runs CI again on top of the latest `main` and squash-merges the PR if CI passes. GitHub then deletes the branch, and `Closes #ID` closes the Issue.

## Worker

The worker is one deployment for every extension: sign-in, the model, credits, and the admin page.

Merging to `main` deploys it through Cloudflare Workers Builds, which runs the worker's tests, applies the [D1](#database) migrations not yet applied, and deploys, so new code never runs on an old schema. The build is set up in the dashboard with root directory `worker`, build command `pnpm install --frozen-lockfile && pnpm test` (on Node.js 24, for `node:sqlite`), deploy command `npx wrangler d1 migrations apply cofun-db --remote && npx wrangler deploy` (what `pnpm run deploy` runs), and an API token with **D1: Edit**, which applying migrations and finding `cofun-db` by name need. To deploy by hand:

```bash
cd worker
pnpm exec wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID=<account id> pnpm run deploy
```

Run it locally with `pnpm dev` in `worker/`. Local overrides go in `worker/.dev.vars` (to use the admin page there, add `http://localhost:8787` to `CLERK_AUTHORIZED_PARTIES`).

The AI Gateway (`AI_GATEWAY_ID`) has **log collection turned off** in the dashboard (Settings > Collect logs). Model calls also turn it off per request, but a web search can't (`worker/src/search.ts`), and with it on the gateway would keep every search query, which may hold Notion text. Its cache is off too.

Configuration is the `vars` in [`worker/wrangler.jsonc`](../worker/wrangler.jsonc), each explained by its comment. The two secrets, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, are set with `pnpm exec wrangler secret put <name>` and never committed; without them nothing can be bought. How admins are recognized (a `role` claim in the Clerk session token) is in `worker/src/routes/admin.ts`.

There is no test environment: the one worker runs with the live Stripe account. After a deploy that changes buying, the maintainer checks it once by hand: buy the US$5 pack with a real card, see the credits arrive in the side panel, refund the payment in the Stripe Dashboard, and see what was left taken back. It costs one payment's fees, so it is never part of `pnpm e2e`.

### Database

Grants and spends of credits are kept in the D1 database `cofun-db` (binding `DB`), created once on the deploying account with `cf d1 create --name cofun-db`. Its schema is the migration files in `worker/migrations/`, applied in order on every deploy. A new migration is a new file with the next number; never change one that was applied. Query it with `cf d1 query <database id> --sql "…"` (`cf d1 list --name cofun-db` shows the id); amounts are micro-credits (1 credit = 1,000,000) and times are ms since the epoch. D1 runs one query at a time, so a query over a whole table holds up charging: bound it by time.

Per-request usage records go to the Analytics Engine dataset `cofun_api_usage` (binding `USAGE`), queried with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/); the order of its columns is `recordUsage` in `worker/src/usage.ts`. They are for watching the service, never for charging.

## Extensions

```bash
pnpm build        # builds Cofun and Notico into extensions/<name>/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick the extension’s `dist` folder. You can load both builds at the same time.

`extensions/notico/.env` holds the public build config, each value explained by its comment; override values in `extensions/notico/.env.local`. A development build sends no usage events to PostHog; to try them from a local build, build it with `POSTHOG_IN_DEV=1`. The PostHog project keeps **Discard client IP data** on, which the privacy pages rely on. Don't run PostHog's setup wizard on this repository: it adds the SDK with defaults that send page titles and URLs.

To run the extension against your own deployment under an ID of your own, generate a signing key and set its public half as `CRX_PUBLIC_KEY`, then allow its origin (`chrome-extension://<extension id>`) in the worker's `CLERK_AUTHORIZED_PARTIES` and in the Clerk instance's `allowed_origins`:

```bash
mkdir -p extensions/notico/keys
openssl genrsa -out extensions/notico/keys/crx-private.pem 2048
openssl rsa -in extensions/notico/keys/crx-private.pem -pubout -outform DER > extensions/notico/keys/pub.der
base64 -i extensions/notico/keys/pub.der | tr -d '\n'                          # CRX_PUBLIC_KEY
shasum -a 256 extensions/notico/keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'  # extension ID
```

The Clerk instance needs the Native API on; a production one also needs its DNS records, its own OAuth credentials, and its JWT public key as the worker's `CLERK_JWT_KEY` ([Clerk's Sync Host guide](https://clerk.com/docs/guides/sessions/sync-host)). When the sign-in page's registrable domain has more than two labels (such as `example.co.uk`), set it as `CLERK_COOKIE_DOMAIN` in `.env.local` (`manifest.ts`).

For the Cofun prototype, use `extensions/cofun/.env.local` and the same steps above with the Cofun folder. To sign in and use hosted chat, allow the Cofun build’s separate origin in your Clerk instance and Worker. Use the same Clerk instance and Worker for both extensions to share an account and its credits. Chrome keeps each extension’s chats and settings separately.

Another extension goes through the same steps in its own folder. To release it, add its folder name to the `extension` choices in [`release.yml`](../.github/workflows/release.yml), once it has browser tests (`browser-test/` and a `test:browser` script).

## Releases

Releasing an extension to the Chrome Web Store, from the changelog to submitting it for review, is in [release.md](release.md).
