# notion-copilot

**Copilot for Notion**: a Chrome extension that opens an AI side panel next to your Notion pages to help you read and edit them.

```
┌────────────────── Chrome ──────────────────┐
│ Notion page │ Side panel (React)            │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│             │  chat                         │                                (verifies JWT)
├─────────────┴───────────────────────────────┤      ▲ reads the session cookie (Clerk Sync Host)
│ Sign-in tab: notion-copilot.kitfun.cc/login │──────┘  this page is served by the same worker
└─────────────────────────────────────────────┘
```

## Status

- [x] Side panel opens from the toolbar icon on Notion tabs
- [x] Sign in on a web page (Google supported); the session syncs into the extension
- [x] Chat with streamed replies
- [x] Basic agent: the model calls tools that run in the extension (first tool: the current page's title and URL)
- [x] Sessions: start, list, search, filter by page, delete, and resume past conversations, kept on the device
- [x] Read Notion pages as Markdown: the open page or another one, in parts when long
- [x] Search the workspace for pages, then read what it finds
- [x] List the workspace's pages like the sidebar, or the pages under a page
- [x] Edit Notion pages: insert, replace, and delete content by block, after the user approves each change
- [x] Create pages with content, after the user approves
- [x] Work on what the user selected in the page

## Tech choices

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion; enabled only on Notion tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds logs, caching, and per-user analytics |
| API shape | OpenAI-compatible `/v1/chat/completions` | A common streaming format, so the extension doesn't change if the model or backend does |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extension/src/agent.ts` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `agent.ts` imports it, so it can be replaced |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |
| Notion read/write | Notion's own internal endpoints (`/api/v3/loadPageChunk` to read, `/api/v3/saveTransactionsFanout` to write), called from inside the user's Notion tab with `chrome.scripting` | Verified to read and write a real page, with edits persisting after reload. Requests are same-origin and carry the tab's own Notion session (sessions are per host: `app.notion.com` and `www.notion.so` don't share one), so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

### Auth flow

1. The user clicks "Sign in" in the side panel. The extension opens `https://notion-copilot.kitfun.cc/login` in a new tab; the worker serves this page with Clerk's sign-in UI.
2. After sign-in, Clerk's session cookie lives on that domain. The extension is configured with `syncHost` and uses the `cookies` permission to read that session. Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). If the token has an `azp` (the web origin that requested it), it must be an allowed origin, which stops other websites from using a session they obtained in the browser. Tokens the extension gets through Clerk's Native API carry no `azp`. No network call to Clerk is needed.
5. The worker counts the request against the user's daily quota (a Durable Object per user, reset at 00:00 UTC) and refuses it once the quota is used up.
6. The request goes through AI Gateway to Workers AI, tagged with the Clerk user id for per-user analytics. Gateway log collection is off (`collectLog: false`), so the gateway keeps request analytics but not prompts or replies.
7. The worker writes one usage record for the request (see [Usage records](#usage-records)).

The extension ID is pinned with the manifest `key`, so Clerk and the worker can trust it.

### Sessions

Conversations are saved in the extension's IndexedDB, one database per Clerk user (`notion-copilot-sessions-<userId>`), and never sent to the worker beyond what the model needs for the current question. They stay after sign-out so the user can pick up again, and they are not encrypted: keeping accounts apart only means one account's panel never shows another's sessions. Anyone with access to the Chrome profile can read them, tool results included, such as the content of Notion pages the agent read (for example in DevTools).

## Layout

```
extension/                Chrome extension
  vite.config.ts          build config; generates manifest.json from .env
  sidepanel.html
  src/background.ts       opens the side panel from the toolbar icon; enabled only on Notion tabs
  src/agent.ts            agent loop (pi) against the worker; the only module that imports pi
  src/tools.ts            tools the agent runs in the extension
  src/sessions.ts         saved sessions (IndexedDB, per user)
  src/notion/hosts.ts     Notion hosts, and the page id in a Notion URL
  src/notion/api.ts       Notion's internal API: endpoints, request shapes, record maps, errors
  src/notion/markdown.ts  Notion pages as Markdown for the model, with a reference on each block
  src/notion/blocks.ts    Markdown from the model back into Notion blocks
  src/notion/edit.ts      checks edits against the page as the agent read it, and plans the transaction
  src/notion/tree.ts      pages as the sidebar lists them, level by level, without content
  src/notion/tab.ts       runs Notion requests in the user's Notion tab (chrome.scripting)
  src/sidepanel/          React UI (main.tsx: sign-in, Chat.tsx: chat)
worker/                   Cloudflare Worker
  src/app.ts              Hono app: Clerk JWT verification + /v1/chat/completions
  src/quota.ts            per-user daily request quota (UserQuota Durable Object in src/index.ts)
  src/usage.ts            per-request usage records (Workers Analytics Engine), no message content
  src/login.ts            sign-in page (Clerk Sync Host)
  test/                   REST integration tests (real signed JWTs, fake AI binding), and tests of
                          the extension's client code (fake Notion tab with sanitized fixtures)
docs/
  bdd.md                  how use cases and scenarios are written
  use-cases/              use cases by domain; tests reference their scenario IDs
.github/rulesets/         GitHub branch rulesets (export format)
.github/dependabot.yml    weekly dependency updates
scripts/
  sync-github-settings.sh applies the rulesets and repository options with gh
AGENTS.md                 development workflow and conventions (CLAUDE.md links here)
```

## Development

Requires Node.js 24 and pnpm.

```bash
pnpm install
pnpm check        # lint, format check, typecheck, extension build, worker tests
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it on every pull request.

See [AGENTS.md](AGENTS.md) for the issue → PR → review → merge workflow.

### GitHub settings

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](.github/rulesets/main.json): no deletion or force push, linear history of signed commits, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](.github/dependabot.yml).

A repository admin runs it from their machine with `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

### Worker

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

#### Usage records

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

#### Workers Builds settings

In the Cloudflare dashboard: Workers & Pages → `notion-copilot` → Settings → Builds → connect `kitfun/notion-copilot`.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

### Extension

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
