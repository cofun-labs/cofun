# Architecture

How Cofun's extensions and the backend they share are built, and why. This file holds the core design only: the parts, the boundaries between them, and where data flows. Update it when a change adds, moves, or removes a module boundary or anything listed under [Layout](#layout), or changes where data goes or comes from (a new host, store, or route). Limits, constants, index names, UI details, and edge-case behavior belong in code comments, next to the code they describe. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md); for the security model see [security.md](security.md).

Each Cofun extension is an AI side panel for one kind of page, in its own folder under `extensions/` (Notico, for Notion, is the first), built and published by itself. All of them call one Cloudflare Worker (`worker/`), which signs users in, checks who is asking, keeps their credits, passes the conversation to the model, and reads public web pages and searches the web for an extension. It never talks to Notion or acts as the user on any site. The agent and its tools run in the extension, next to the page they act on.

Each extension keeps its own app: the side panel, its sessions, the prompt, the site layer and its tools, the manifest, and the usage events. Only libraries the extensions call are shared, as workspace packages in `packages/`, where the extensions must not differ: `@cofun/worker-client` is the client of the worker (the hosted model's lookup, the cost its replies carry, web reads and searches, credits and checkout, and how the panel words the credits) and of Clerk sign-in, so most of the worker's API, which must stay compatible with the extension versions on the Chrome Web Store, is read in one place. `@cofun/agent` is the agent runtime and tool framework: the agent loop on pi and the rules for calling outside services that its tool calls keep, the model providers (the hosted one, which keeps what the worker accepts of its requests: the model's limits, the request format, and how much history to send; and OpenRouter), and `defineTool`, with the model settings and the mode (Edit or Read only) each account keeps on the device, the user's own key among them. An extension gives it its prompt, its tools, its memory of a chat, and the worker's client; its tools and which of them a question is offered stay the extension's. `@cofun/tools` holds the tools that would fit any extension, written on `@cofun/agent`'s tool framework, and the site layers they read the web with: the site layer for a page in one of the user's tabs and for DuckDuckGo, the free web search a user can choose, and the tools that read the current tab and the tabs the user added, web pages by their address, and web searches, with the long results they keep on the device; and the handoff of text selected with the context menu to the side panel. An extension passes it its name and what is particular to its own site (Notico's Notion pages are read with its own tools). `@cofun/analytics` sends an extension's usage events to PostHog, and nothing else: each extension lists its own events. A package takes what is particular to an extension as parameters and never imports one; the rest of the side panel is still a copy per extension, and a fix in one is applied to the others by hand. One account and one balance of credits serve every extension.

## Single source of truth

Each fact is stored in one place, and everything else is worked out from it when it is read. A copy, a cache, or a stored total is added only when reading the source is too slow or costs too much, and then the code says which is the source and how the copy is kept right. Two stores that each hold part of the same fact drift apart, and then nobody can say which one is right.

For example, a user's balance is not stored: it is worked out each time from their grants and what each spend took from each grant. Rows of the credits are written once and never changed, so nothing in them is a running total that could drift. Data kept only for watching the service, such as the usage records in Analytics Engine, is not a copy in this sense: nothing the service does reads it.

## Shared by every extension: the worker, sign-in, and credits

| Area | Choice | Why |
|---|---|---|
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds per-user analytics |
| API shape | OpenAI-compatible chat completions | A common streaming format, so the extension doesn't change if the model or backend does |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |

### Auth flow

1. The user clicks "Sign in" in an extension's side panel, which opens the sign-in page the worker serves, with Clerk's sign-in UI, in a new tab.
2. Sign-in runs against Clerk's instance, whose cookies live on `cofun.cc`. The extension reads that session through Sync Host, with the `cookies` permission, and watches the cookies to notice sign-in and sign-out.
3. Before each request, the extension gets a short-lived session JWT from Clerk and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's public key, with no call to Clerk, and checks that the origin it names, if any, is allowed ([security.md](security.md#accepted-a-session-token-that-names-no-origin)).
5. The worker checks the user's credits ([Credits](#credits)), passes the request through AI Gateway to Workers AI, tagged with the Clerk user id and the extension that sent it, and charges what the call cost when it ends.

Each extension's ID is pinned with its manifest `key`, so Clerk and the worker can trust it.

### Credits

Using the hosted model, rendering a web page, and searching the web cost credits. A credit is money, and each costs what it costs at the provider's list price, with no markup. Every signed-in user gets free credits each week.

- **The ledger** is one D1 database for every user, the only source of truth for billing. It holds grants (free, by hand, or bought, each with when it expires) and spends (each with what it cost and what it took from each grant), with a table of its own for what is particular to each kind. Spending takes from the grant that expires first. Rows are never deleted, so what was granted and spent can be totalled over any period. A balance never goes below zero: a cost the grants do not cover is forgiven.
- **Every change is one D1 batch**, which D1 runs as a transaction, so requests from one user that run at once are each charged once and none is lost.
- **The free grant is lazy**: it is given when a request that spends credits arrives and the user has none that still counts. No schedule runs.
- **Charging is after use.** A paid call goes ahead while the balance is above zero, and is charged when it ends, even if the client went away: a failed one costs nothing, and a reply the user stopped is charged an estimate. A per-user rate limit bounds what calls sent at once can cost beyond the balance. Every answer says what it cost.
- **Admins** use a page the worker serves, which holds no data and calls the admin routes with its session token.
- **Buying credits** goes through Stripe's hosted Checkout, Stripe being the merchant of record. Only the worker talks to Stripe; the extension only opens the Checkout page. Stripe's signed webhook reports the payment, which adds a grant, and a refund or dispute takes back what is left of it; each event is safe to repeat, in any order.
- **When the database fails**, a request whose credits can't be read is refused before the model is called, and a call whose record fails is not charged.

### Web pages

An extension can have the worker read a public web page by its address, plainly or, for a page drawn by scripts, rendered in Cloudflare's Browser Run, and search the web through the same AI Gateway as the model, with one search provider fixed in code. Which address to read or what to search is the extension's choice (Notico: the model's), since the worker does not see the conversation. A plain read is free; renders and searches are charged ([Credits](#credits)). What the worker refuses to read, and what it never keeps, is in [security.md](security.md#sign-in-and-the-worker).

## Notico: the extension for Notion

```
┌──────────────────────── Chrome ─────────────────────────┐
│ Notion tab            │ Side panel (React)              │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│  /api/v3 as the user ◀──chrome.scripting── agent + tools│                                (verifies JWT)
├───────────────────────┴─────────────────────────────────┤      ▲ reads the Clerk cookies signing in sets (Clerk Sync Host)
│ Sign-in tab: api.cofun.cc/login                         │──────┘  this page is served by the same worker
└─────────────────────────────────────────────────────────┘
                                                            Worker ──▶ web pages, Browser Run, and Web Search (through AI Gateway)
```

The agent loop and its tools run in the side panel. Notion requests are made inside the user's own Notion tab, with that tab's session. A user may instead have their own model answer, on OpenRouter with their own key: the side panel asks it directly, behind the agent's `ModelProvider`, so those questions never reach the worker; web pages and searches still go through the worker, and renders and searches are still charged, unless the user chose DuckDuckGo for searches (below).

The panel is open on every tab, but the tools act on the current tab, and on the tabs on other sites the user added to the chat. The Notion tools work only while the current tab is on Notion. On another site, the agent reads the page inside the tab, through `@cofun/tools`'s site layer for any page, only on a site the user allowed: web sites are optional host permissions, asked for one at a time. No request goes to that site. The "Ask Notico" context menu item adds text selected in any page to the next question. The clip items write a page, or the text selected on it, to the Notion page chosen in Settings, outside any question and without the agent or the worker: the side panel reads it in the tab the click gave it, shows the chosen page in a Notion tab (opening one if none shows it), and writes there. Web pages and searches go through the worker, with addresses and queries the model chooses ([security.md](security.md#accepted-web-pages-at-any-address)), except that a user can choose in Settings to search with DuckDuckGo: `@cofun/tools`'s site layer for it then opens DuckDuckGo's results page in a background tab, reads it with `chrome.scripting`, with the host permission the user granted, and closes it; such searches cost no credits.

A question carries the pages it goes with (the open page, and pages and tabs the user adds) as titles and URLs, not their content: the model reads them with its tools.

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion. One panel per window, on every tab, so the conversation stays as the user switches tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `@cofun/agent` (`packages/agent/`) | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `@cofun/agent` imports it, so it can be replaced |
| Notion read/write | Notion's own internal endpoints, called from inside the user's Notion tab with `chrome.scripting` | Requests are same-origin and carry the tab's own Notion session, so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

### Sessions

A saved conversation is a *session* in code and a *chat* in everything users read. Sessions are kept in the extension's IndexedDB, one database per Clerk user, and are sent to the worker only as far as the model needs them for the current question. They stay after sign-out and are not encrypted, and what is read back is parsed before it is used. The same database keeps the full text of long tool results, which the model reads in parts. When a request outgrows its budget, the agent asks the selected model for a summary. The chat record keeps that summary with its cut point and the original messages. Subsequent requests use the summary and recent messages. Leaving a session mid-question stops the question, and the session keeps the tools it used, so continuing later does not repeat a change.

The user can save a reply, or the whole chat, as a new Notion page. It is the user's own action, not a tool the agent is offered.

### Writes without approval

The agent changes Notion without asking first, except to move pages to the trash; Read only is the switch for a user who does not want that. The trade-off is in [security.md](security.md#accepted-writes-without-approval).

### Usage data

Notico sends product analytics to [PostHog](https://posthog.com) straight from the side panel, not through the worker, through one module whose `track` takes a fixed list of events, which `@cofun/analytics` sends ([AGENTS.md](../AGENTS.md), "Usage data: never content"). Usage data can be switched off in Settings. The worker sends the one event the extension cannot see, that a purchase was completed.

### Account and credits in the side panel

Clerk's own account management is not used: Notico needs Clerk only for who the user is, and disconnecting the only sign-in method could leave a user unable to get back to their account and its credits. The panel reads the credits from the worker; a read that fails never touches the chat.

## Confluco

Confluco is built independently from `extensions/confluco/`. It runs its own copy of the side panel and local chat store, and the agent of `@cofun/agent`. It signs in through the same Cofun Worker, sends `confluco/<version>` as its client name, and uses the account's shared credits. Its browser tools read the current tab or tabs a user added through `@cofun/tools`, with the same site grant flow as Notico. Public web reads and searches go through the Worker, except that a user can choose in Settings to search with DuckDuckGo, as in Notico. Its context menu hands a selection to the side panel as Notico's does.

A user connects one Confluence base URL per Cofun account in Settings. The Confluence site layer checks the connected origin and deployment context. Requests run in the captured Confluence tab with that tab's session. Self-managed Confluence supports published-page reads, space, history, discussion and attachment inspections, and explicit page changes. Atlassian-hosted Confluence Cloud uses its own REST endpoints with the same tool definitions to read and search published pages and inspect spaces, page trees, versions, access, discussions, labels and attachments. It also creates child pages, renames pages, adds or removes ordinary labels, posts footer comments and replies, moves or copies pages within a space, moves eligible pages to recoverable trash, edits published text, and restores trashed pages through the native confirmation form. A verified text edit or trash action can be undone in the chat. The restore form and its CSRF value are read and submitted inside the captured site tab. The question offers Confluence tools for the captured site's capabilities. An explicit composer action can attach selected editor text to a question or stage a local file for upload. The file bytes go directly to the connected Confluence site once confirmed. Cloud attachment writes use the site's native upload action and verify the attachment through REST. The session store keeps a verified edit or trash reversal with the chat on the device.

## Layout

The folders, and the modules that hold a boundary; other files are found by their folder and name.

```
extensions/<name>/        one Chrome extension, built and published by itself; never imports another
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  PRIVACY.md, README.md   for the extension's users
  store/                  what the Chrome Web Store Dashboard says
  src/tool.ts             @cofun/agent's defineTool, bound to the extension's memory of a chat
  src/tools/              the tools the agent runs (index.ts lists them)
  src/notion/             the site layer for Notion: imports nothing from the agent, tools, sessions, or UI
    api.ts                the only module that knows Notion's endpoints and request shapes
    tab.ts                runs same-origin requests in the user's Notion tab with chrome.scripting
  src/confluence/         Confluco's REST and editor selection. cloud.ts and cloud-inspection.ts define Cloud reads, and cloud-writes.ts, cloud-organization.ts, cloud-edits.ts and cloud-status.ts define Cloud writes.
                          tab.ts calls the site inside the captured tab, and instance.ts saves the connection per Cofun account
  src/sidepanel/          the React UI
    panel.ts              the Panel: the open chat, the saved sessions, the credits, the model and the mode;
                          imports no React, which subscribes to it
    chat-session.ts       a ChatSession per chat: what it shows, its agent, its question, and its saves;
                          imports no React either
  src/analytics.ts        the extension's usage events; the only module that uses @cofun/analytics
  src/zod.ts              the only module that imports zod
  test/                   the extension's client and UI tests, with fakes and sanitized fixtures
  browser-test/           pnpm test:browser: the built extension in Chromium, the network answered by fakes (runs in CI)
  use-cases/              the extension's use cases (docs/bdd.md)
packages/<name>/          a library the extensions call (workspace package); never imports an extension
  src/zod.ts              the package's only module that imports zod
  test/                   tests of the rules the package owns
packages/agent/           @cofun/agent: the agent loop and its tool calls, the model providers (the hosted
                          one and OpenRouter), and defineTool; the only package that imports pi
                          (/models and /mode: the model settings and the mode each account keeps on the device)
packages/analytics/       @cofun/analytics: sends an extension's usage events to PostHog; the only module that imports
                          the PostHog SDK
packages/tools/           @cofun/tools: the generic tools (tabs, web pages, searches, long results) and the site layers
                          they read the web with
  src/tab.ts              the site layer for a page in a tab: reads the page a tab shows, once the user allowed
                          its site; sends no request. Imported as @cofun/tools/tab, which loads no agent
  src/markdown.ts         turns the HTML a tab gives into Markdown, in the side panel, in an inert document
  src/duckduckgo/         the site layer for DuckDuckGo, the free web search a user can choose: search.ts knows its
                          endpoint and result page; tab.ts opens the page in a background tab and reads it
  src/selection.ts        the context menu's selection, handed to the side panel of its window. Imported as
                          @cofun/tools/selection, which the service worker loads, with no agent
  src/tools/              the tools, as factories that take the extension's name and its own site
packages/worker-client/   @cofun/worker-client: the client of the worker's API (the hosted model's own requests
                          go through the agent), and Clerk sign-in
                          (/clerk, which a build loads in Node; /credits, the credits in words, which loads
                          no client)
worker/                   the Cloudflare Worker every extension shares
  src/app.ts              the Hono app, composed from src/routes/; everything under /v1 is behind
                          the session check (src/routes/session.ts)
  src/routes/             the routes, one Hono sub-app per area
  src/credits.ts          the credit ledger over D1
  src/charge.ts           charging after use: a paid call costs nothing when it failed
  src/web.ts              reads web pages: the only module that fetches an outside address or calls Browser Run
  src/search.ts           searches the web through AI Gateway, with the one search provider
  src/stripe.ts           the only module that talks to Stripe
  migrations/             the D1 schema, applied on deploy
  test/                   REST integration tests with fakes, and an extension's agent run against the worker
  use-cases/              rules only the worker decides
e2e/                      pnpm e2e: drives the shared Chrome Canary for ai-e2e runs
scripts/                  repository scripts (use case coverage, GitHub settings, PR media, changelog)
docs/                     this file, development, security, and BDD
.oxlintrc.json            lint rules, including the module boundaries
.github/                  workflows, rulesets, issue forms, Dependabot
```
