# Development

Requires Node.js 24 and pnpm.

```bash
pnpm install
pnpm check        # lint, format check, typecheck, extension build, and every package's tests
pnpm smoke        # build the extension and load it into Chromium (first: pnpm --filter notion-copilot-smoke exec playwright install chromium)
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it and `pnpm smoke` on every pull request.

See [AGENTS.md](../AGENTS.md) for the issue → PR → review → merge workflow.

## GitHub settings

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history of signed commits, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

A repository admin runs it from their machine with `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

## Worker

Merging to `main` deploys the worker through Cloudflare Workers Builds. To deploy by hand:

```bash
cd worker
npx wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID=<account id> pnpm run deploy
```

The worker runs on the custom domain `notion-copilot.kitfun.cc` (see `routes` in `wrangler.jsonc`). The domain's zone must belong to the deploying Cloudflare account.

Variables in `wrangler.jsonc`:

| Variable | Description |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key, used by the sign-in page |
| `AI_GATEWAY_ID` | AI Gateway id; leave empty to call Workers AI directly |
| `MODEL` | The only model clients can use |
| `DAILY_REQUEST_LIMIT` | Chat requests each user may make per UTC day; counted in the `UserQuota` Durable Object (one per user) |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins, comma-separated: `chrome-extension://<extension id>` and the sign-in page |
| `CLERK_JWT_KEY` | Clerk JWT public key (PEM). Public; also available at `https://<frontend-api>/.well-known/jwks.json` |

### Usage records

Every chat request that passes auth leaves one data point in the `notion_copilot_usage` Analytics Engine dataset (binding `USAGE`), written when the reply ends, is refused, or fails. Records hold sizes, token counts, and the outcome, never message or reply text. Analytics Engine deletes them after 90 days.

| Column | Value |
|---|---|
| `index1` | Clerk user id |
| `blob1` | model |
| `blob2` | outcome: `ok`, `incomplete` (stream ended early), `cancelled`, `stream_error`, or the error code returned (`rate_limited`, `provider_error`, `quota_unavailable`, `bad_request`, …). A stream whose model reports an error is `provider_error` |
| `blob3` | finish reason: `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty |
| `blob4` | `stream` or `sync` |
| `double1` … `double5` | messages, input characters (message text, tool calls, and tool definitions), prompt tokens, completion tokens, duration in ms (until the request was refused, the reply was sent, or a stream ended; for streams it includes the time the client spends reading) |

Query them with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), for example requests and tokens per user per day:

```sql
SELECT index1 AS user, toStartOfDay(timestamp) AS day,
       sum(_sample_interval) AS requests,
       sum(_sample_interval * double3) AS prompt_tokens,
       sum(_sample_interval * double4) AS completion_tokens,
       sumIf(_sample_interval, blob2 != 'ok' AND blob2 != 'cancelled') AS failed
FROM notion_copilot_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY user, day
ORDER BY day DESC, requests DESC
```

### Workers Builds settings

In the Cloudflare dashboard: Workers & Pages → `notion-copilot` → Settings → Builds → connect `kitfun/notion-copilot`.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

## Extension

```bash
pnpm build        # outputs extension/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `extension/dist`.

`extension/.env` holds the public build config. To point at your own deployment, override values in `extension/.env.local`:

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `VITE_CLERK_SYNC_HOST` | URL of the sign-in page (the worker's domain) |
| `VITE_API_URL` | Worker base URL, including `/v1` |
| `CRX_PUBLIC_KEY` | Extension signing public key; pins the extension ID |
| `CLERK_COOKIE_DOMAIN` | Optional. The registrable domain Clerk sets its cookies on, e.g. `example.co.uk`. Defaults to the last two labels of the sign-in page's host |

Generate your own signing key and extension ID:

```bash
mkdir -p extension/keys
openssl genrsa -out extension/keys/crx-private.pem 2048
openssl rsa -in extension/keys/crx-private.pem -pubout -outform DER > extension/keys/pub.der
base64 -i extension/keys/pub.der | tr -d '\n'                          # CRX_PUBLIC_KEY
shasum -a 256 extension/keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'  # extension ID
```

In the Clerk dashboard, enable the Native API (Native applications page) so the Chrome extension can sign in.
