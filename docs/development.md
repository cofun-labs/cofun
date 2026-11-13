# Development

Requires Node.js 24 and pnpm.

```bash
pnpm install
pnpm check        # lint, unused code check (knip), format check, typecheck, extension build, and every package's tests
pnpm knip         # unused files, exports, and dependencies (knip.jsonc lists what is kept, and why)
pnpm smoke        # build the extension and load it into Chromium (first: pnpm --filter notion-copilot-smoke exec playwright install chromium)
pnpm icons        # export extensions/notico/icons/icon.svg into extensions/notico/public/icons (needs the same Chromium); commit the PNGs
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it and `pnpm smoke` on every pull request.

See [AGENTS.md](../AGENTS.md) for the issue → PR → review → merge workflow.

## GitHub settings

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, auto-merge allowed (on a branch with a merge queue, `gh pr merge` adds a PR to the queue through it), secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

A repository admin runs it from their machine with `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

## Worker

Merging to `main` deploys the worker through Cloudflare Workers Builds. To deploy by hand (`pnpm run deploy` applies the [database](#credits-database) migrations first, like the build's deploy command):

```bash
cd worker
npx wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID=<account id> pnpm run deploy
```

The worker runs on the custom domain `api.cofun.cc` (see `routes` in `wrangler.jsonc`). The domain's zone must belong to the deploying Cloudflare account.

Variables in `wrangler.jsonc`:

| Variable | Description |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key, used by the sign-in page. The hosted worker uses the production instance (`pk_live_…`, Frontend API `clerk.cofun.cc`) |
| `AI_GATEWAY_ID` | AI Gateway id; leave empty to call Workers AI directly |
| `MODEL` | The only model clients can use. Its token prices must be listed in `worker/src/pricing.ts`: without them every chat request is refused as `not_configured` |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins, comma-separated: `chrome-extension://<extension id>` and the sign-in page |
| `PRODUCTS` | Which product each extension is, by its origin (the token's `azp`), as a JSON object: `{"chrome-extension://<extension id>": "notico"}`. Model calls from any other caller are recorded as `unknown` |
| `CLERK_JWT_KEY` | Clerk JWT public key (PEM). Public; also available at `https://<frontend-api>/.well-known/jwks.json` |

### Admin page

`https://<worker domain>/admin` shows an admin what was granted and spent across all accounts in a period of up to 92 days (in all, per day, per product, and per account, the biggest spenders first), and lets them look up one account's credits by Clerk user id (Clerk dashboard → Users shows it) and grant it credits by hand. See [Credits](architecture.md#credits) for how it is protected and how the overview is read. Days are days on the clock of the computer the page is open on.

Who is an admin is set in Clerk, on the instance whose keys the worker uses. Two settings, both in the Clerk dashboard:

1. **Sessions → Customize session token → Claims**: add the `role` claim, next to any claims already there, and save. The worker reads exactly this claim name.

   ```json
   {
     "role": "{{user.public_metadata.role}}"
   }
   ```

2. **Users → the admin's user → Metadata → Public → Edit**: set the role. The worker accepts exactly the string `admin`.

   ```json
   {
     "role": "admin"
   }
   ```

Without the first, no token carries a role and nobody is an admin; without the second, that user is not one. A user's new role reaches the worker with their next session token, within about a minute. To remove an admin, remove the `role` from their public metadata. Users cannot change their own public metadata: only the dashboard and Clerk's Backend API (with the secret key) write it. Never put the role in unsafe metadata, which users can write themselves.

The worker's own origin (`https://<worker domain>`) must be in `CLERK_AUTHORIZED_PARTIES`: admin requests are accepted only with a session token issued to that origin. To use the page with `wrangler dev`, add the local origin (`http://localhost:8787`) there, in `worker/.dev.vars`.

Each grant made by hand is written to Workers Logs as one line: `manual grant: admin=<user id> user=<user id> credits=<n> expires=<time>`.

### Usage records

Every chat request that passes auth leaves one data point in the `cofun_api_usage` Analytics Engine dataset (binding `USAGE`), written when the reply ends, is refused, or fails. Records hold sizes, token counts, the credits charged, and the outcome, never message or reply text. Analytics Engine deletes them after 90 days. They are for watching the service: they describe every request, refused and failed ones too. Users are charged from the credits database below (see [Credits](architecture.md#credits)), never from these records.

| Column | Value |
|---|---|
| `index1` | Clerk user id |
| `blob1` | model |
| `blob2` | outcome: `ok`, `incomplete` (stream ended early), `cancelled`, `stream_error`, or the error code returned (`out_of_credits`, `provider_error`, `credits_unavailable`, `bad_request`, …). A stream whose model reports an error is `provider_error` |
| `blob3` | finish reason: `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty |
| `blob4` | `stream` or `sync` |
| `blob5` | product: `notico`, another extension's name, or `unknown` (see `PRODUCTS`) |
| `double1` … `double5` | messages, input characters (message text, tool calls, and tool definitions), prompt tokens, completion tokens, duration in ms (until the request was refused, the reply was sent, or a stream ended; for streams it includes the time the client spends reading) |
| `double6`, `double7` | cached prompt tokens (the part of the prompt tokens the model read from its cache), micro-credits charged (1 credit = 1,000,000; 0 when nothing was charged). For a reply that was stopped or broke off, the token counts are the estimate it was charged by |

Query them with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), for example requests, tokens, and credits per user per day:

```sql
SELECT index1 AS user, toStartOfDay(timestamp) AS day,
       sum(_sample_interval) AS requests,
       sum(_sample_interval * double3) AS prompt_tokens,
       sum(_sample_interval * double4) AS completion_tokens,
       sum(_sample_interval * double7) / 1000000 AS credits,
       sumIf(_sample_interval, blob2 != 'ok' AND blob2 != 'cancelled') AS failed
FROM cofun_api_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY user, day
ORDER BY day DESC, requests DESC
```

### Credits database

Grants and model calls (with what each cost) are kept in the D1 database `cofun-db` (binding `DB`), on the account that deploys the worker. `wrangler.jsonc` names it and does not hold its id: on deploy, wrangler finds the database by name on that account, so the id never has to be committed. The schema is the migration files in `worker/migrations/`, applied in order on every deploy (see the deploy command below). A new migration is a new file with the next number; never change one that was applied.

Create the database once, on the account that deploys the worker (with several accounts in one login, choose one with `CLOUDFLARE_ACCOUNT_ID`; don't commit it):

```bash
cf d1 create --name cofun-db
```

Apply the migrations by hand, for example before the first deploy (wrangler finds the database by name; [`cf d1 migrations apply`](https://developers.cloudflare.com/d1/reference/migrations/) does the same with the database id, which `cf d1 list --name cofun-db` shows):

```bash
cd worker
pnpm exec wrangler d1 migrations apply cofun-db --remote
```

Query it with `cf d1 query <database id> --sql "…"`, or in the dashboard (Storage & databases → D1 → `cofun-db` → Console). Amounts are micro-credits (divide by 1,000,000 for credits) and times are ms since the epoch. Rows are never deleted. The [admin page](#admin-page) shows what was granted and spent per day and per account; the queries below are for what it does not show, or for a longer time than it covers. D1 runs one query at a time, so a query over a whole table holds up charging while it runs: bound it by time where you can. Credits granted and spent per day, with calls and tokens, across all users:

```sql
SELECT day, sum(granted) / 1e6 AS credits_granted, sum(spent) / 1e6 AS credits_spent,
       sum(calls) AS calls, sum(prompt_tokens) AS prompt_tokens, sum(completion_tokens) AS completion_tokens
FROM (
  SELECT date(granted_at / 1000, 'unixepoch') AS day, amount AS granted, 0 AS spent, 0 AS calls,
         0 AS prompt_tokens, 0 AS completion_tokens FROM grants
  UNION ALL
  SELECT date(started_at / 1000, 'unixepoch'), 0, micro_credits, 1, prompt_tokens, completion_tokens FROM model_calls
)
GROUP BY day ORDER BY day DESC LIMIT 30
```

Calls and credits spent per user over the last 7 days, with how many calls failed (every outcome but `ok`) and how many of those the user stopped:

```sql
SELECT user_id, count(*) AS calls, sum(micro_credits) / 1e6 AS credits_spent,
       sum(prompt_tokens) AS prompt_tokens, sum(cached_tokens) AS cached_tokens,
       sum(completion_tokens) AS completion_tokens,
       sum(outcome <> 'ok') AS failed, sum(outcome = 'cancelled') AS cancelled
FROM model_calls
WHERE started_at > (unixepoch() - 7 * 86400) * 1000
GROUP BY user_id ORDER BY credits_spent DESC
```

Granted per user and source, and what each user owes now (`sum(owed)` of their model calls less `sum(repaid)` of their grants):

```sql
SELECT user_id, source, count(*) AS grants, sum(amount) / 1e6 AS credits_granted, sum(left) / 1e6 AS credits_left
FROM grants GROUP BY user_id, source ORDER BY user_id, source;

SELECT u.user_id,
       ((SELECT coalesce(sum(owed), 0) FROM model_calls c WHERE c.user_id = u.user_id)
        - (SELECT coalesce(sum(repaid), 0) FROM grants g WHERE g.user_id = u.user_id)) / 1e6 AS credits_owed
FROM (SELECT DISTINCT user_id FROM grants) u ORDER BY credits_owed DESC;
```

### Workers Builds settings

In the Cloudflare dashboard: Workers & Pages → `cofun-api` → Settings → Builds → connect `cofun-labs/cofun`.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `npx wrangler d1 migrations apply cofun-db --remote && npx wrangler deploy` |
| Production branch | `main` |

The deploy command applies the migrations not yet applied to `cofun-db`, then deploys, so new code never runs on an old schema. Wrangler skips its confirmation in CI, and a migration that fails is rolled back and stops the deploy. The build's API token (Workers & Pages → `cofun-api` → Settings → Builds → API token) needs **D1: Edit** on the account, both to apply the migrations and to find `cofun-db` by name. A token that Workers Builds creates has it (checked on one created in November 2026); a token made by hand needs it added. The worker's tests use Node's built-in `node:sqlite`, so the build needs Node.js 24 (the Workers Builds default).

## Extension

```bash
pnpm build        # outputs extensions/notico/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `extensions/notico/dist`.

`extensions/notico/.env` holds the public build config. To point at your own deployment, override values in `extensions/notico/.env.local`:

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key, of the same instance as the worker's. It names the Frontend API host, which the manifest allows |
| `VITE_CLERK_SYNC_HOST` | URL of the sign-in page (the worker's domain). With a development instance's key (`pk_test_…`) Clerk syncs the session from this host; with a production instance's key (`pk_live_…`) it syncs from the Frontend API host instead |
| `VITE_API_URL` | Worker base URL, including `/v1` |
| `CRX_PUBLIC_KEY` | Extension signing public key; pins the extension ID |
| `CLERK_COOKIE_DOMAIN` | Optional. The registrable domain Clerk sets its cookies on, e.g. `example.co.uk`. Defaults to the last two labels of the sign-in page's host |

Generate your own signing key and extension ID:

```bash
mkdir -p extensions/notico/keys
openssl genrsa -out extensions/notico/keys/crx-private.pem 2048
openssl rsa -in extensions/notico/keys/crx-private.pem -pubout -outform DER > extensions/notico/keys/pub.der
base64 -i extensions/notico/keys/pub.der | tr -d '\n'                          # CRX_PUBLIC_KEY
shasum -a 256 extensions/notico/keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'  # extension ID
```

In the Clerk dashboard, enable the Native API (Native applications page) so the Chrome extension can sign in. Development and production instances have separate settings, keys, and users: do it on the instance whose keys you use.

A production instance also needs:

- Its DNS records in place, so the Frontend API answers at `clerk.<your domain>`. The sign-in page must be on the same registrable domain, because that is where Clerk sets its cookies.
- Your own OAuth credentials for each social sign-in (Clerk's shared ones work only on development instances).
- The extension's origin (`chrome-extension://<extension id>`) in the instance's `allowed_origins`, set through Clerk's Backend API as [Clerk's Sync Host guide](https://clerk.com/docs/guides/sessions/sync-host) describes.
- `CLERK_JWT_KEY` taken from that instance: the PEM form of the key at `https://clerk.<your domain>/.well-known/jwks.json`.
