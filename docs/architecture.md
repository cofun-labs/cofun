# Architecture

How Cofun's extensions and the backend they share are built, and why. This file holds the core design only: the parts, the boundaries between them, and where data flows. Update it when a change adds, moves, or removes a module boundary or anything listed under [Layout](#layout), or changes where data goes or comes from (a new host, store, or route). Limits, constants, index names, UI details, and edge-case behavior belong in code comments, next to the code they describe. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md); for the security model see [security.md](security.md).

Each Cofun extension is an AI side panel for one kind of page, in its own folder under `extensions/` (Notico, for Notion, is the first), built and published by itself. All of them call one Cloudflare Worker (`worker/`), which signs users in, checks who is asking, keeps their credits, and passes the conversation to the model. The worker knows nothing about any site: it never talks to Notion or any other page's service, and the one outside page it reads is a public web page an extension asks for by its address (see [Web pages](#web-pages)), as anyone who is not signed in would. The agent and its tools run in the extension, next to the page they act on.

Each extension keeps its own copy of the side panel code (UI, agent, sign-in, settings, credits), and duplication between extensions is accepted: a fix or feature in one is applied to the others by hand, and an extension's tests run its own agent against the worker so the part that faces the worker cannot drift. One account and one balance of credits serve every extension.

## Single source of truth

Each fact is stored in one place, and everything else is worked out from it when it is read. A copy, a cache, or a stored total is added only when reading the source is too slow or costs too much, and then the code says which is the source and how the copy is kept right. Two stores that each hold part of the same fact drift apart, and then nobody can say which one is right.

For example, a user's balance is not stored: it is worked out from their grants and model calls each time. The one stored running value in the credits is what is left of each grant (`grants.left`): working it out would mean replaying every call in the order grants are spent, so it is written in the same transaction as the call that spends it. Data kept only for watching the service, such as the usage records in Analytics Engine, is not a copy in this sense: nothing the service does reads it.

## Shared by every extension: the worker, sign-in, and credits

| Area | Choice | Why |
|---|---|---|
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds logs, caching, and per-user analytics |
| API shape | OpenAI-compatible `/v1/chat/completions` | A common streaming format, so the extension doesn't change if the model or backend does |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |

### Auth flow

1. The user clicks "Sign in" in an extension's side panel. The extension opens `https://api.cofun.cc/login` in a new tab; the worker serves this page with Clerk's sign-in UI.
2. Sign-in runs against Clerk's instance, whose Frontend API is `clerk.cofun.cc`: Clerk's client cookie lives on that host, and a cookie saying whether anyone is signed in on the parent domain `cofun.cc`. The extension is configured with `syncHost` and reads that session with the `cookies` permission (`src/clerk.ts`). Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). The token's `azp` (the origin that requested it: `chrome-extension://<id>` for the extension, the worker's own origin for the admin page) must be an allowed origin when the token names one. A token with no `azp` is let through: Clerk hands a side panel that just loaded one. Other websites cannot get a session token of either kind, because Clerk's Frontend API refuses their origin ([security.md](security.md#accepted-a-session-token-that-names-no-origin)). No network call to Clerk is needed.
5. The worker checks the user's credits (see [Credits](#credits)) and refuses the request when none are left.
6. The request goes through AI Gateway to Workers AI, tagged with the Clerk user id and the product for per-user analytics. The product is the one the extension names in its `X-Cofun-Client` header (`notico/0.3.0`; the version is not kept), or `unknown`: it only sorts what was spent, so the worker takes the client's word for it, and `azp` is used only to check the session. Gateway log collection is off, so the gateway keeps request analytics but not prompts or replies.
7. When the reply ends, the worker records the model call and charges the user what its tokens cost, and writes one usage record for the request (see [Database](development.md#database)).

Each extension's ID is pinned with its manifest `key`, so Clerk and the worker can trust it.

### Credits

Using the hosted model costs credits. A credit is money, and a model call costs what its tokens cost at the provider's list price, with no markup (`worker/src/pricing.ts`). Every signed-in user gets free credits each week.

- **The ledger** (`worker/src/credits.ts`) is one D1 database for every user, the only source of truth for billing. `grants` has one row per grant (free, by hand, or bought), with what is left of it and when it expires; `model_calls` has one row per call the worker made to the model, however it ended, with what it cost. Spending takes from the grant that expires first. Rows are never deleted, so what was granted and spent can be totalled over any period. A balance never goes below zero: a cost the grants do not cover is forgiven.
- **Every change is one D1 batch**, which D1 runs as a transaction, with conditional inserts and relative updates, so requests from one user that run at once on different machines are each charged once and none is lost.
- **The free grant is lazy**: it is given when a chat request arrives and the user has none that still counts. No schedule runs.
- **Charging is after use.** A call goes ahead while the balance is above zero, and its cost is taken when the reply ends, from what the model reported (or an estimate when the reply was cut short). The call, its record, and its charge run in the request's `waitUntil`, so a client that goes away still pays. A per-user rate limit on chat requests bounds what calls sent at once can cost beyond the balance. Every reply says what it cost, in the body or in the stream's last chunk.
- **Admins** use a page the worker serves (`/admin`), which holds no data and calls `/v1/admin/*` with its session token: the token must carry the `admin` role from Clerk and come from the worker's own origin.
- **The side panel reads a user's own credits** from `/v1/credits` (balance, grants, usage per day) and their history from `/v1/credits/grants`, for the caller only.
- **Buying credits** goes through Stripe's hosted Checkout with Managed Payments, Stripe being the merchant of record. Only the worker talks to Stripe (`worker/src/stripe.ts`, `worker/src/billing.ts`); the extension only opens the Checkout page. The worker makes a Checkout Session for a pack and writes the user on it; Stripe's signed webhook (`/stripe/webhook`) reports the payment, which adds a grant, and a refund or dispute takes back what is left of it. Webhook events may arrive in any order and more than once, and each is safe to repeat. After opening Checkout, the panel reads the credits again when it gets the focus.
- **When the database fails**, a request whose credits can't be read is refused before the model is called, and a call whose record fails is not charged.

### Web pages

An extension can have the worker read a web page by its address (`/v1/web/read`): the worker fetches it with no cookie or credential, follows redirects one at a time, and turns its HTML into text (`worker/src/web.ts`). A page drawn by scripts shows no text that way, and the extension can then ask for it rendered (`/v1/web/render`): the worker has Cloudflare's Browser Run load it in a browser (the `BROWSER` binding) and return it as Markdown. Both are free for now; a render costs the operator browser time, so renders have a per-user cap of their own (`RENDER_LIMIT`), far below the one on reads, until they are charged in credits ([#464](https://github.com/cofun-labs/cofun/issues/464)). The worker refuses addresses on our own domain, on local network names, and given as IP addresses, at every redirect; which addresses to read is the extension's choice (Notico: the model's), since the worker does not see the conversation. Neither route keeps or logs the address or the page.

## Notico: the extension for Notion

```
┌──────────────────────── Chrome ─────────────────────────┐
│ Notion tab            │ Side panel (React)              │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│  /api/v3 as the user ◀──chrome.scripting── agent + tools│                                (verifies JWT)
├───────────────────────┴─────────────────────────────────┤      ▲ reads the Clerk cookies signing in sets (Clerk Sync Host)
│ Sign-in tab: api.cofun.cc/login                         │──────┘  this page is served by the same worker
└─────────────────────────────────────────────────────────┘
```

The agent loop and its tools run in the side panel. The worker only checks who is asking and passes the conversation to the model. Notion requests are made inside the user's own Notion tab, with that tab's session. A user may instead have their own model answer, on OpenRouter with their own key: the side panel asks it directly, behind the agent's `ModelProvider` (`src/agent/`), so those questions never reach the worker and spend no credits. The providers, keys, and models switched on are kept per account in `chrome.storage.local` (`src/models.ts`).

The panel is open on every tab, but the tools act on the current tab only, besides the tabs on other sites the user added to the chat: the current tab is the active tab of the panel's window, looked up again for each question and each tool call. The Notion tools fail on a tab that is not on Notion, and never use a Notion page open in another tab. On another site, `get_current_tab` gives the tab's URL and title, and `read_current_tab` reads the page's text inside the tab, through a second site layer (`src/web/`), on a site the user allowed: the manifest asks for web sites only as optional host permissions, and the tool's card asks Chrome for one origin when the user clicks Allow. No request goes to that site; the text goes to the model with the conversation. `read_tab` reads a tab on another site the same way, only one the user added to a question of the chat, by Chrome's id for it, whatever page it shows by then. Chrome hands out tab ids again after a restart, so each added tab in a chat records the run of the browser it was added in, which `chrome.storage.session` names until the browser closes, and a tab from an earlier run is not read. The context menu's "Ask Notico" item, on text selected in any page, opens the panel and adds the selection to the next question: the service worker (`src/background.ts`) reads it in the tab the click gave it (`activeTab`) and hands it to that window's panel through `chrome.storage.session` (`src/selection.ts`). A web page is read by its address with `read_web_page`, or `render_web_page` for one drawn by scripts, through the worker ([Web pages](#web-pages)), whichever model answers; the model chooses the address ([security.md](security.md#accepted-web-pages-at-any-address)).

A question carries the pages it goes with (the open page, and pages and tabs the user adds with `@` or "+") as titles and URLs, not their content: the model reads them with its tools. The page picker suggests open tabs (Notion pages, and the window's tabs on other sites) and pages from saved sessions without asking Notion, asks Chrome for a site when the user picks a tab on one not allowed yet, and searches the workspace through the same Notion layer as the tools, never while a question is being answered, so the picker and the agent never ask Notion at once.

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion. One panel per window, on every tab (the manifest's `side_panel.default_path`), so the conversation stays as the user switches tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extensions/notico/src/agent/` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `src/agent/` imports it, so it can be replaced |
| Notion read/write | Notion's own internal endpoints (`/api/v3/loadPageChunk` to read, `/api/v3/saveTransactionsFanout` to write), called from inside the user's Notion tab with `chrome.scripting` | Verified to read and write a real page, with edits persisting after reload. Requests are same-origin and carry the tab's own Notion session (sessions are per host: `app.notion.com` and `www.notion.so` don't share one), so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

### Sessions

A saved conversation is a *session* in code and a *chat* in everything users read. Sessions are kept in the extension's IndexedDB, one database per Clerk user (`src/sessions.ts`), and are sent to the worker only as far as the model needs them for the current question. They stay after sign-out and are not encrypted. What is read back is parsed against the session's schemas; a session that doesn't parse is never opened or sent to the model. Leaving a session mid-question stops the question, and the session keeps the tools it used, so continuing later does not repeat a change. The model that answered a session's first question writes its title.

The user can save a reply, or the whole chat, as a new Notion page under the open page (`src/tools/save.ts`). It is the user's own action, not a tool the agent is offered, and is written the way `create_page` writes, once, with no retry.

### Writes without approval

The agent changes Notion without asking first; moving pages to the trash is the one thing it asks for each time. Each change shows on its tool card, and Notion's page history can undo edits. The trade-off: text the user doesn't control (shared pages, guest content, search results) can carry an instruction that makes the agent write as the user without anyone being asked. It could change many pages, move a private page under one others can read, or copy what the user can see where someone else can read it, and a comment or mention notifies other people. Read only is the switch for a user who does not accept this; what else limits it is in [security.md](security.md#accepted-writes-without-approval).

### Usage data

Notico sends product analytics to [PostHog](https://posthog.com) straight from the side panel, not through the worker. One module, `src/analytics.ts`, wraps the SDK and exports `track`, which takes one of a fixed list of events; a lint rule keeps every other module from importing the SDK. An event never holds content: every property is an enum, a number, or a boolean, checked against the event's schema, and a name that comes from the model is sent only when it is on a fixed list. The SDK's own collection is all off, and properties it adds that are not on the module's list are dropped. Usage data can be switched off in Settings, and a build with no project key never starts the SDK. The worker sends the one event the extension cannot see, `purchase_completed` (`worker/src/analytics.ts`).

### Account and credits in the side panel

The avatar opens the panel's own account menu (Credits, Settings, Sign out). Clerk's `<UserButton />` and its account management are not used: Notico needs Clerk only for who the user is, and disconnecting the only sign-in method could leave a user unable to get back to their account and its credits. The panel reads the credits from the worker when it loads, after every question, and when the credits are shown; a read that fails never touches the chat. Each reply on the hosted model shows what it cost, added up from the cost the worker sends with each call; a reply stopped or failed shows none rather than a number that is too low.

## Layout

The folders, and the modules that hold a boundary; other files are found by their folder and name.

```
extensions/<name>/        one Chrome extension, built and published by itself; never imports another
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  PRIVACY.md, README.md   for the extension's users
  store/                  what the Chrome Web Store Dashboard says
  src/agent/              the agent loop and its model providers; the only folder that imports pi, and the
                          only one besides the site layer that uses fetch (the worker, the user's own model)
  src/tools/              the tools the agent runs (index.ts lists them)
  src/notion/             the site layer for Notion: imports nothing from the agent, tools, sessions, or UI
    api.ts                the only module that knows Notion's endpoints and request shapes
    tab.ts                runs requests in the user's Notion tab; with src/web/tab.ts, the only use of chrome.scripting and site fetch
  src/web/tab.ts          the site layer for any other site: reads the page in the current tab, once the user allowed its site
  src/sidepanel/          the React UI
  src/analytics.ts        usage events; the only module that imports the PostHog SDK
  src/zod.ts              the only module that imports zod
  test/                   the extension's client and UI tests, with fakes and sanitized fixtures
  browser-test/           pnpm test:browser: the built extension in Chromium, the network answered by fakes (runs in CI)
  use-cases/              the extension's use cases (docs/bdd.md)
worker/                   the Cloudflare Worker every extension shares
  src/app.ts              the Hono app, composed from src/routes/; everything under /v1 is behind
                          the session check (src/routes/session.ts)
  src/routes/             the routes, one Hono sub-app per area
  src/credits.ts          the credit ledger over D1
  src/web.ts              reads web pages: the only module that fetches an outside address or calls Browser Run
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
