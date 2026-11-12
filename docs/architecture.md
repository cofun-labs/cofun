# Architecture

How Notico is built, and why. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md).

```
┌──────────────────────── Chrome ─────────────────────────┐
│ Notion tab            │ Side panel (React)              │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│  /api/v3 as the user ◀──chrome.scripting── agent + tools│                                (verifies JWT)
├───────────────────────┴─────────────────────────────────┤      ▲ reads the Clerk cookies signing in sets (Clerk Sync Host)
│ Sign-in tab: notico-api.cofun.cc/login                  │──────┘  this page is served by the same worker
└─────────────────────────────────────────────────────────┘
```

The agent loop and its tools run in the side panel. The worker only checks who is asking and passes the conversation to the model; it never talks to Notion. Notion requests are made inside the user's own Notion tab, with that tab's session.

The panel is open on every tab, but the tools work on the current tab only: the active tab of the panel's window, looked up again for each question and each tool call, since the user can switch tabs at any time. Each question tells the model whether that tab is a Notion page (and which), and nothing else about a tab on another site. The Notion tools are offered everywhere; when the current tab is not on Notion they fail with `no_notion_tab`, which tells the model to send the user to a Notion page, and they never use a Notion page open in another tab instead. `get_current_tab` gives the model the current tab's URL and title on any site when a question needs them; no tool reads another site's content.

## Tech choices

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion. One panel per window, on every tab (the manifest's `side_panel.default_path`), so the conversation stays as the user switches tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds logs, caching, and per-user analytics |
| API shape | OpenAI-compatible `/v1/chat/completions` | A common streaming format, so the extension doesn't change if the model or backend does |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extension/src/agent.ts` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `agent.ts` imports it, so it can be replaced |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |
| Notion read/write | Notion's own internal endpoints (`/api/v3/loadPageChunk` to read, `/api/v3/saveTransactionsFanout` to write), called from inside the user's Notion tab with `chrome.scripting` | Verified to read and write a real page, with edits persisting after reload. Requests are same-origin and carry the tab's own Notion session (sessions are per host: `app.notion.com` and `www.notion.so` don't share one), so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

## Auth flow

1. The user clicks "Sign in" in the side panel. The extension opens `https://notico-api.cofun.cc/login` in a new tab; the worker serves this page with Clerk's sign-in UI.
2. Sign-in runs against Clerk's production instance, whose Frontend API is `clerk.cofun.cc`. After sign-in, Clerk's client cookie (`__client`) lives on that host, and a cookie that says whether anyone is signed in (`__client_uat`) on the parent domain `cofun.cc`. The extension is configured with `syncHost` and uses the `cookies` permission to read that session: from the Frontend API host on a production instance, and from the sign-in page's host on a development instance, which keeps its client cookie there (`src/clerk.ts`). Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). If the token has an `azp` (the web origin that requested it), it must be an allowed origin, which stops other websites from using a session they obtained in the browser. Tokens the extension gets through Clerk's Native API carry no `azp`. No network call to Clerk is needed.
5. The worker checks the user's credits (see [Credits](#credits)) and refuses the request when none are left.
6. The request goes through AI Gateway to Workers AI, tagged with the Clerk user id for per-user analytics. Gateway log collection is off (`collectLog: false`), so the gateway keeps request analytics but not prompts or replies.
7. When the reply ends, the worker charges the user what its tokens cost, and writes one usage record for the request (see [Usage records](development.md#usage-records)).

The extension ID is pinned with the manifest `key`, so Clerk and the worker can trust it.

## Sessions

Conversations are saved in the extension's IndexedDB, one database per Clerk user (`notion-copilot-sessions-<userId>`), and never sent to the worker beyond what the model needs for the current question. They stay after sign-out so the user can pick up again, and they are not encrypted: keeping accounts apart only means one account's panel never shows another's sessions. Anyone with access to the Chrome profile can read them, tool results included, such as the content of Notion pages the agent read (for example in DevTools).

## Writes without approval

The agent edits pages, creates pages and rows, changes properties, adds comments, and moves and duplicates pages without asking first. Moving pages to the trash is the one thing it asks the user's approval for, each time, showing each page by its current name; pages only ever go to Notion's trash, where they can be restored. Each change shows on its tool card in the side panel, and a page's history in Notion can undo edits. The trade-off: the agent reads text the user doesn't control (shared pages, guest content, search results), and an instruction hidden in that text can make it write as the user without anyone being asked. It could change many pages in one call, move a private page under a page others can read (a page takes its sharing from where it sits, so it is exposed as soon as it moves), or copy content the user can see into a page or a comment someone else can read; a comment also notifies the people following the page or the thread, and a mention notifies the person mentioned. When a mention's name matches no one, the agent is told the members with a similar name, so text in a page could have it probe for the names of the workspace's people. Page history and "Move to" can undo the changes, but not what someone read in the meantime.

## Credits

Using the hosted model costs credits. A credit is money: 1 US dollar = 1000 credits, and a model call costs what its tokens cost at the provider's list price, with no markup. Every signed-in user gets 200 free credits a week.

- **The ledger** (`worker/src/credits.ts`) is one Durable Object per Clerk user id, and the only source of truth for billing. The balance is not one number: the ledger keeps grants, each with its amount, what is left of it, when it expires, and where it came from (only `free` for now). Spending takes from the grant that expires first, and an expired grant counts for nothing. Amounts are integers in micro-credits (1 credit = 1,000,000), so the cost of one call is exact. The usage records in Analytics Engine are sampled and kept for 90 days: they are for analysis and for checking the ledger, never for charging.
- **The free grant** is given lazily: when a request arrives and the user has no free grant that has not expired, the ledger grants 200 credits that expire 7 days later. No schedule runs, nothing is written for users who don't come back, and grants don't add up: a user who returns after a month gets one.
- **Prices** (`worker/src/pricing.ts`) are a table per model, in micro-credits per token, with input the model read from its prompt cache priced apart: it is far cheaper, and an agent resends its instructions, tool definitions, and the conversation on every call. The hosted model reports the cached part of the prompt as `usage.prompt_tokens_details.cached_tokens`. A `MODEL` with no entry is a configuration error (503), not a free call. AI Gateway's cost numbers are only for checking; its logs stay off.
- **Charging is after use.** A call goes ahead when the balance is above zero, and its cost is taken when the reply ends, so the last call of a question may take the balance below zero. That overdraft is kept as a debt, which the next grant pays back first. So that calls sent at once can't all start on the same credits, the balance check sets aside (holds) the most the call can cost: every character of input as a token of new input, plus every token of reply it may write. A call starts only when the balance less the holds of calls still running is above zero, otherwise it is refused (429 `credits_in_use`); its hold is dropped when it is charged, or after 15 minutes if the charge never came. The overdraft is therefore always less than one call's cost. With no credits left the request is refused before any model call (402 `out_of_credits`), with a message that says when the next free grant arrives.
- **What a call costs when it does not end well.** A call that fails costs what it reported: nothing when the model never answered, and nothing for a stream that carried a model error and no usage, or that broke off before it reported or carried anything. A reply the user stops, or a stream that breaks off, costs what it used. Its totals come in the stream's last chunks, which never arrived, so they are estimated: the prompt is the count the first chunk gave (Workers AI sends it there), or one token per 3 characters of input when no chunk gave one; the reply is one token per 3 characters streamed (text, reasoning, and tool calls), and never below what the stream did report. How much of the prompt was read from the cache is only known at the end, so 90% of it is charged as cached input and the rest as new: an agent resends its instructions, tools, and the conversation on every call, so most of a prompt usually is cached. A stream that ran to its end (`[DONE]`) before the client stopped reading has its totals, and is charged by them.
- **A client that goes away** does not get a free call. The model call and its charge are handed to the request's `waitUntil`, so they finish after a client drops the request, before the reply or partway through a stream.
- **When the ledger fails.** If the balance can't be read, the request is refused (503 `credits_unavailable`) and the model is not called. If the charge fails after the model answered, the reply still goes out, the failure is logged, the usage record says nothing was charged, and the call's hold stays until it expires.

## Layout

```
extension/                Chrome extension
  vite.config.ts          build config; writes manifest.json into the build
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  icons/icon.svg          the extension icon; `pnpm icons` exports it into public/icons, which the manifest lists
  sidepanel.html
  src/background.ts       opens the side panel from the toolbar icon, on any tab
  src/agent.ts            agent loop (pi) against the worker; the only module that imports pi
  src/tools.ts            tools the agent runs in the extension
  src/tool.ts             defines a tool from one zod schema of its arguments
  src/clerk.ts            Clerk's Frontend API host and Sync Host, read from the publishable key
  src/zod.ts              zod, set up for the extension's content security policy; the only module that imports it
  src/sessions.ts         saved sessions (IndexedDB, per user)
  src/notion/hosts.ts     Notion hosts, and the page id in a Notion URL
  src/notion/api.ts       Notion's internal API: endpoints, request shapes, record maps, errors
  src/notion/markdown.ts  Notion pages as Markdown for the model, with a reference on each block
  src/notion/blocks.ts    Markdown from the model back into Notion blocks
  src/notion/edit.ts      checks edits against the page as the agent read it, and plans the transaction
  src/notion/comments.ts  a page's comment threads for the model, quoted so they read as data
  src/notion/people.ts    matches the people mentions name to the workspace's members
  src/notion/props.ts     page titles and database property values, checked against the database's schema
  src/notion/schema.ts    a database's properties: a new database's schema, and checked changes to one
  src/notion/tree.ts      pages as the sidebar lists them, level by level, without content
  src/notion/tab.ts       runs Notion requests in the user's Notion tab (chrome.scripting)
  src/sidepanel/          React UI (main.tsx: sign-in, Chat.tsx: chat, Sessions.tsx: saved sessions,
                          ToolCall.tsx: one tool call and its changes, Header.tsx: the top bar,
                          icons.tsx: the Cofun mark and the icons, style.css: the look)
  test/                   tests of the extension's client code (fake Notion tab with sanitized
                          fixtures), and of the side panel's UI: the whole panel in jsdom
                          (*.test.tsx)
worker/                   Cloudflare Worker
  src/app.ts              Hono app: Clerk JWT verification + /v1/chat/completions
  src/credits.ts          per-user credit ledger: grants, expiry, spending (UserCredits Durable Object in src/index.ts)
  src/pricing.ts          what each model's tokens cost in credits
  src/usage.ts            per-request usage records (Workers Analytics Engine), no message content
  src/login.ts            sign-in page (Clerk Sync Host)
  test/                   REST integration tests (real signed JWTs, fake AI binding), and the
                          extension's agent run against the worker
e2e/                      pnpm e2e: drives the shared Chrome Canary over CDP for ai-e2e runs
                          (maintainer's machine only; its unit tests run in pnpm test)
smoke/                    pnpm smoke: loads the built extension into Chromium and checks that it
                          still works (Notion and Clerk answered from fixtures; runs in CI)
docs/
  architecture.md         this file
  development.md          setup, deployment, and repository settings
  assets/                 pictures used by README.md
  bdd.md                  how use cases and scenarios are written, and how to run ai-e2e scenarios
  use-cases/              use cases by domain; tests reference their scenario IDs
.oxlintrc.json            lint rules, including the extension's module boundaries
.github/rulesets/         GitHub branch rulesets (export format)
.github/workflows/        CI, CodeQL, dependency review, workflow lint, Claude review, and Claude on request
.github/dependabot.yml    weekly dependency updates
scripts/
  sync-github-settings.sh applies the rulesets and repository options with gh
README.md                 what the extension does and how to use it
PRIVACY.md                what data the extension reads, where it goes, and what is kept
AGENTS.md                 development workflow and conventions (CLAUDE.md links here)
```
