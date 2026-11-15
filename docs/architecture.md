# Architecture

How Cofun's extensions and the backend they share are built, and why: the core design only. It changes when a module boundary, the code layout, or a data flow changes; limits, constants, index names, and edge cases are kept in code comments. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md).

Each Cofun extension is an AI side panel for one kind of page, in its own folder under `extensions/` (Notico, for Notion, is the first), built and published by itself. All of them call one Cloudflare Worker (`worker/`), which signs users in, checks who is asking, keeps their credits, and passes the conversation to the model. The worker knows nothing about any site: it never talks to Notion or any other page's service. The agent and its tools run in the extension, next to the page they act on.

Each extension keeps its own copy of the side panel code (UI, agent, sign-in, settings, credits), and duplication between extensions is accepted: a fix or feature in one is applied to the others by hand, and `worker/test/extension.test.ts` runs an extension's own agent against the worker so the part that faces the worker cannot drift. One account and one balance of credits serve every extension.

## Single source of truth

Each fact is stored in one place, and everything else is worked out from it when it is read. A copy, a cache, or a stored total is added only when reading the source is too slow or costs too much, and then the code says which is the source and how the copy is kept right. Two stores that each hold part of the same fact drift apart, and then nobody can say which one is right.

For example, a user's balance and what they owe are not stored: they are worked out from their grants and model calls each time. What a call cost is a column of the call's own row, not a second record. The one stored running value in the credits is what is left of each grant (`grants.left`): working it out would mean replaying every call in the order grants are spent, and it is written in the same transaction as the call that spends it. Data kept only for watching the service, such as the usage records in Analytics Engine, is not a copy in this sense: it describes requests in its own way (refused ones included), and nothing the service does reads it.

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
2. Sign-in runs against Clerk's production instance, whose Frontend API is `clerk.cofun.cc`. After sign-in, Clerk's client cookie (`__client`) lives on that host, and a cookie that says whether anyone is signed in (`__client_uat`) on the parent domain `cofun.cc`. The extension is configured with `syncHost` and uses the `cookies` permission to read that session: from the Frontend API host on a production instance, and from the sign-in page's host on a development instance, which keeps its client cookie there (each extension's `src/clerk.ts`). Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). The token's `azp` (the origin that requested it: `chrome-extension://<id>` for the extension, the worker's own origin for the admin page) must be an allowed origin, and a token with no `azp` is refused, which stops other websites from using a session they obtained in the browser. No network call to Clerk is needed.
5. The worker checks the user's credits (see [Credits](#credits)) and refuses the request when none are left.
6. The request goes through AI Gateway to Workers AI, tagged with the Clerk user id and the product for per-user analytics. The product is the one `PRODUCTS` (in `wrangler.jsonc`) lists for the token's `azp`, which Clerk signs, so a client cannot choose it; an allowed origin that is no listed extension (the admin page) is `unknown`, and is not refused, since credits are one balance across products and the product only sorts what was spent. Gateway log collection is off (`collectLog: false`), so the gateway keeps request analytics but not prompts or replies.
7. When the reply ends, the worker records the model call and charges the user what its tokens cost, and writes one usage record for the request (see [Database](development.md#database)).

Each extension's ID is pinned with its manifest `key`, so Clerk and the worker can trust it.

### Credits

Using the hosted model costs credits. A credit is money (1,000 credits to the US dollar), and a model call costs what its tokens cost at the provider's list price, with no markup. Every signed-in user gets free credits each week.

- **The ledger** (`worker/src/credits.ts`) is one D1 database for every user (binding `DB`, schema in `worker/migrations/`), the only source of truth for billing. The `grants` table has one row per grant (its amount, what is left, when it expires, and its source: `free`, `manual`, or `purchase`); the `model_calls` table has one row per call the worker made to the model, however it ended, with its tokens and what it cost. Spending takes from the grant that expires first. Rows are never deleted, so what was granted and spent can be totalled over any period. Amounts are integers in micro-credits, so the cost of one call is exact.
- **Debt** is not a number of its own: a call records the part of its cost no grant covered (`model_calls.owed`), and a grant the part of its amount that paid debt back (`grants.repaid`). Every grant pays debt back first.
- **Concurrency.** Every change to the ledger is one D1 batch, which D1 runs as a transaction. The lazy free grant is one conditional insert, and a call that ends takes its cost with a relative update in the same batch as its record, so requests that arrive or end together are each handled once.
- **The free grant** is given lazily, when a chat request arrives and the user has no free grant that still counts: no schedule runs, and nothing is written for users who don't come back.
- **Prices** (`worker/src/pricing.ts`) are a table per model, with input read from the model's prompt cache priced apart. A `MODEL` with no entry is a configuration error, not a free call.
- **Charging is after use.** A call goes ahead when the balance is above zero, and its cost is taken when the reply ends, so the last call may leave a debt. Nothing is set aside for calls still running; a per-user rate limit on chat requests (`CHAT_LIMIT` in `wrangler.jsonc`) bounds what calls sent at once can overspend. Every other `/v1` route has a per-user limit of its own (`API_LIMIT`), which keeps one account from keeping D1 or Stripe busy. With no credits left the request is refused before any model call (402 `out_of_credits`). A reply the user stops, or a stream that breaks off, is charged by an estimate of what it used (`worker/src/pricing.ts`). Every reply says what its call cost: in the body next to `usage`, or in the stream's last chunk before `[DONE]`.
- **A client that goes away** does not get a free call: the model call, its record, and its charge are handed to the request's `waitUntil`.
- **Admins** look up an account, grant it credits by hand, and see what was granted and spent across accounts, on a page the worker serves (`/admin`, `worker/src/admin.ts`, `worker/src/overview.ts`). The page holds no data: it calls `/v1/admin/*` with its session token, which must carry the `role` claim `admin` (from the user's public metadata in Clerk, which only Clerk's dashboard and Backend API can write) and whose `azp` must be the worker's own origin. Every number is worked out from the ledger's rows when asked for.
- **A user's own credits** are read by the side panel from `GET /v1/credits` (balance, grants that still count, the free week, and usage per day), and their history from `GET /v1/credits/grants`, a page at a time. Both are for the caller only, only read, and store nothing.
- **Buying credits** (`worker/src/billing.ts`, `worker/src/stripe.ts`) is one-time purchases of fixed packs through Stripe's hosted Checkout, with Managed Payments: Stripe is the merchant of record and adds the tax. Only the worker talks to Stripe's API; the extension only opens the Checkout page in a normal tab. A pack is a quantity of one price (`CREDIT_PRICE`, `CREDIT_PACKS`). The panel asks the worker for a Checkout Session (`POST /v1/billing/checkout`), the worker writes the user id, price, and quantity on it, and Stripe's signed webhook (`POST /stripe/webhook`) reports the payment, which adds one grant of source `purchase`. A refund or dispute takes back what is left of the grant. Events may arrive in any order and more than once: the grant carries the payment's reference (unique), so a payment reported twice grants once, and a refund or dispute that arrives before its grant is recorded against the payment (`revoked_payments`), which then never grants. After opening Checkout, the panel reads the credits again each time it gets the focus, so a purchase shows when the user comes back.
- **When the database fails**, a request whose balance can't be read is refused before the model is called (503 `credits_unavailable`). If the call's record fails after the model answered, the reply still goes out and the call is not charged: the batch wrote both the record and the charge, or neither.

## Notico: the extension for Notion

```
┌──────────────────────── Chrome ─────────────────────────┐
│ Notion tab            │ Side panel (React)              │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│  /api/v3 as the user ◀──chrome.scripting── agent + tools│                                (verifies JWT)
├───────────────────────┴─────────────────────────────────┤      ▲ reads the Clerk cookies signing in sets (Clerk Sync Host)
│ Sign-in tab: api.cofun.cc/login                         │──────┘  this page is served by the same worker
└─────────────────────────────────────────────────────────┘
```

The agent loop and its tools run in the side panel. The worker only checks who is asking and passes the conversation to the model; it never talks to Notion. A user may instead have their own model answer: on OpenRouter or DeepSeek, with their own key, which the side panel asks directly (both hosts are in the content security policy). Each is a provider behind the agent's `ModelProvider`. Settings decides which providers and models are on, and the composer's model menu picks one of them, or Auto, the hosted model; a key is saved only once it passes a free check against the provider's own account endpoint. All of it is kept per account in `chrome.storage.local` (`models.ts`) and read as each question starts. Such questions never reach the worker and spend no credits. Notion requests are made inside the user's own Notion tab, with that tab's session.

The panel is open on every tab, but the tools work on the current tab only: the active tab of the panel's window, looked up again for each question and each tool call, since the user can switch tabs at any time. Each question tells the model whether that tab is a Notion page (and which), and nothing else about a tab on another site. The Notion tools are offered everywhere; when the current tab is not on Notion they fail with `no_notion_tab`, which tells the model to send the user to a Notion page, and they never use a Notion page open in another tab instead. `get_current_tab` gives the model the current tab's URL and title on any site when a question needs them; no tool reads another site's content.

The page a question goes with is shown at the top of the composer (`Pages.tsx`), read from the tab as Chrome reports it (`chrome.tabs` events, no Notion request), so the question carries what the user saw. The user can take it off; the question's note then names no page, and `carryPages` (`src/tools/current.ts`) makes every tool that would default to the open page (reading it, its comments, its database or selection, and `get_current_tab`) refuse for that question while the tab shows a Notion page, so the model asks or searches instead; on another site they work as they do without a page. The pages a question went with are saved with it in the session and shown in its bubble.

The user adds more pages to a question with `@` in the composer or its "+" button, which open one picker (`PagePicker.tsx`). Its groups are the open page, the other Notion pages open in the browser's tabs (`chrome.tabs`), and recent pages, worked out from the saved sessions (the pages their questions carried, and those their tool calls read or changed, `pagesIn` in `src/tools/index.ts`): none asks anything of Notion. Its fourth group is Notion's own search of the workspace (`findPages` in `src/tools/find.ts`), sent from the Notion tab like any tool's request, and held to the same rules: only once typing pauses, one search at a time (a newer query replaces one still waiting, and waits for one already sent), counted toward no question, and never retried; when Notion turns one away, or one fails, the picker searches no more for that question. The picker and the agent never ask Notion at once: no search goes out while a question is answered, and a question sent while a search is out waits for it, and stops, sending nothing, if Notion turned that search away. The question carries the added pages as titles and URLs in its note (`carryPages`), not their content: the model reads them with its tools when it needs to. A page added by hand stays with the question when the tab moves; the open page's chip follows the tab.

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion. One panel per window, on every tab (the manifest's `side_panel.default_path`), so the conversation stays as the user switches tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extensions/notico/src/agent/` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `src/agent/` imports it, so it can be replaced |
| Notion read/write | Notion's own internal endpoints (`/api/v3/loadPageChunk` to read, `/api/v3/saveTransactionsFanout` to write), called from inside the user's Notion tab with `chrome.scripting` | Verified to read and write a real page, with edits persisting after reload. Requests are same-origin and carry the tab's own Notion session (sessions are per host: `app.notion.com` and `www.notion.so` don't share one), so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

### Sessions

A saved conversation is a *session* in code and a *chat* in everything users read (the side panel, the README, the privacy policy, the store listing); session names in code and storage stay as they are, so that renaming them never loses saved data.

Conversations are saved in the extension's IndexedDB, one database per Clerk user (`notico-sessions-<userId>`), and never sent to the worker beyond what the model needs for the current question. They stay after sign-out so the user can pick up again, and they are not encrypted: keeping accounts apart only means one account's panel never shows another's sessions. Anyone with access to the Chrome profile can read them, tool results included, such as the content of Notion pages the agent read (for example in DevTools).

What is read back is parsed against the session's schemas (`SessionInfo` in `sessions.ts`, `HistoryMessage` in `src/agent/types.ts`), since an earlier version may have saved it in another form. A session that doesn't parse is unreadable: the list shows it as such and offers only to delete it, and it is never opened, so nothing of it reaches the chat or the model. There is no migration or format version yet; they come with the first change to the format that is not only an added optional field.

Leaving a session while a question is being answered, for a new chat or a saved one, stops the question as Stop does; nothing runs in the background. The agent then holds the next conversation, so `ask()` resolves with the conversation its question was asked in, and the panel saves that to the session the user left: it keeps the tools the question used, so continuing it later does not repeat a change already made.

A session is titled with its first question until its first reply is in; then the agent asks the model that answered for a short title (`CopilotAgent.title`), so it goes only where the conversation already went, and on the hosted model it spends credits like any request. The title the model wrote replaces the first question in the stored session, once, and later saves keep it; a failed or unusable answer changes nothing.

With a button under a reply, or one at the top of the panel, the user can save that reply, or the whole chat so far, as a new Notion page (`savePage` in `src/tools/save.ts`, `Save.tsx`). It is the user's own action, not a tool the agent is offered, so Read only does not limit it, and nothing asks to confirm it. The page always goes at the end of the page open in the current tab when the user saves, the same tab rule the tools follow; with no Notion page there the action is unavailable, and a database is refused before anything is written. It is written the way `create_page` writes a page, from the reply's Markdown, in one transaction sent once and never retried: a rate limit stops it with nothing more sent, and an unknown outcome tells the user to look in Notion before saving again. Unlike the picker's search, a save may go out while a question is answered: it is two requests, started by hand, and counted toward no question. A save notifies nobody: people a reply mentions are written as names.

### Writes without approval

The agent edits pages, creates pages and rows, changes properties, adds comments, and moves and duplicates pages without asking first. Moving pages to the trash is the one thing it asks the user's approval for, each time, showing each page by its current name; pages only ever go to Notion's trash, where they can be restored. Each change shows on its tool card in the side panel, and a page's history in Notion can undo edits. The trade-off: the agent reads text the user doesn't control (shared pages, guest content, search results), and an instruction hidden in that text can make it write as the user without anyone being asked. It could change many pages in one call, move a private page under a page others can read (a page takes its sharing from where it sits, so it is exposed as soon as it moves), or copy content the user can see into a page or a comment someone else can read; a comment also notifies the people following the page or the thread, and a mention notifies the person mentioned. When a mention's name matches no one, the agent is told the members with a similar name, so text in a page could have it probe for the names of the workspace's people. Page history and "Move to" can undo the changes, but not what someone read in the meantime.

### Usage data

Notico sends product analytics to [PostHog](https://posthog.com) (US region) straight from the side panel, not through the worker: which features are used and how they end, to see activation, the questions a user's own model answers (which never reach the worker), and how often tools fail. One module, `src/analytics.ts`, wraps the SDK and exports `track`, which takes one of a fixed list of events; a lint rule keeps every other module from importing the SDK. The firm line is that an event never holds content: every property is an enum, a number, or a boolean, checked against the event's schema before it is sent, so a message, a reply, a page's title or URL, or a key has no field to travel in. A tool's name and an error's code are sent only when they are on a fixed list, since the model can name a tool that does not exist.

The SDK sends nothing by itself: autocapture, pageviews, session replay, exception capture, surveys, and its requests for feature flags and remote configuration are all off, it loads no code, and before an event leaves, every property the SDK added that is not on the module's list is dropped (the page's URL, the user agent, the time zone, the screen size). Usage data is on by default, with a switch on the settings page, kept in `chrome.storage.local` for the device: while it is off, or in a build with no project key, the SDK is never started. Before sign-in, events go under a random id the SDK keeps in the extension's localStorage; once signed in, under the Clerk user id, to which the random id is joined. The worker sends the one event the extension cannot see, `purchase_completed`, when a payment adds credits (`worker/src/analytics.ts`), with the Clerk user id and the pack.

### Credits in the side panel

The avatar in the header opens the panel's own account menu (`Account.tsx`): "Credits", "Settings", and "Sign out". Clerk's `<UserButton />` and its account management are not used: Notico needs Clerk only for who the user is, and disconnecting the only sign-in method could leave a user unable to get back to their account and its credits. Each page covers the whole panel with its own Back (`Page` in `Header.tsx`). The Credits page (`Credits.tsx`, `History.tsx`) shows the balance by source, the packs to buy (see [Credits](#credits)), usage per day, and the history of grants; the Settings page (`Settings.tsx`, `Model.tsx`) the model providers and their models, the switch for usage data, and the account. The model chip in the composer (`ModelMenu` in `Model.tsx`) picks Auto or one of the models switched on in Settings. The panel reads the credits when it loads, after every question, and whenever the account menu or the Credits page opens. Each reply on the hosted model that ended normally shows what its question cost (`CostNote` in `Chat.tsx`), added up from the cost the worker sends with each call (`callCost` in `worker.ts`); a reply stopped or failed shows none rather than a number that is too low. A read of the credits that fails never touches the chat.

## Layout

```
extensions/               one folder per Chrome extension, each built and published by itself
                          and never importing another; they share the worker
extensions/notico/        Notico, the extension for Notion
  README.md               what Notico does and how to use it, for its users
  PRIVACY.md              what Notico reads, the hosts it may contact, and what it keeps on the device
  vite.config.ts          build config; writes manifest.json into the build
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  icons/icon.svg          the extension icon; `pnpm icons` exports it into public/icons, which the manifest lists
  sidepanel.html
  src/background.ts       opens the side panel from the toolbar icon, on any tab
  src/agent/              the agent, and the only folder that imports pi (index.ts: what the rest of the extension uses)
    agent.ts              the agent loop: a question, its tool calls, and the conversation it keeps
    types.ts              the agent's types: its config, tools, updates, and the conversation as sessions save it
    calls.ts              tool calls as pi runs them: arguments, previews, the user's OK, errors that stop a question
    history.ts            what of a conversation is sent and kept, and what a question used
    title.ts              a conversation's title, written by the model that answered it
    provider.ts           ModelProvider: where model requests go, and how a service's errors read
    worker.ts             the worker: the hosted model's provider, and the user's credits and purchases
    openrouter.ts         OpenRouter with the user's own key, and its models
    deepseek.ts           DeepSeek with the user's own key, and its models from pi's catalog
    own.ts                the user's own model, and the Settings page's check of its key
  src/models.ts           the providers, their keys and models, and the composer's choice, kept per account on the device
  src/analytics.ts        usage events sent to PostHog, and the switch that turns them off; the only
                          module that imports the PostHog SDK
  src/tools/              tools the agent runs in the extension (index.ts: the list of them)
    read.ts               read_page, get_selection
    find.ts               list_pages, search_pages
    write.ts              edit_page, create_page, update_pages
    database.ts           query_database, create_database, update_database_schema
    organize.ts           move_page, duplicate_page, trash_page
    comments.ts           read_comments, add_comment
    current.ts            the current tab and the page a question carries; get_current_tab
    save.ts               saving a reply or a chat as a Notion page, which the user starts (not a tool)
    shared.ts             common arguments, how a call is worded, and the pages a call names
    load.ts               loads several tools share: a page with its database and mentions, a database, a workspace
    memory.ts             what the agent remembers between calls (pages read, rows and databases seen),
                          behind functions: its maps are its own
  src/tool.ts             defines a tool from one zod schema of its arguments
  src/clerk.ts            Clerk's Frontend API host and Sync Host, read from the publishable key
  src/zod.ts              zod, set up for the extension's content security policy; the only module that imports it
  src/sessions.ts         saved sessions (IndexedDB, per user)
  src/credits.ts          the user's credits as the worker reports them, and how the panel words them
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
                          Markdown.tsx: a reply's text as formatted Markdown,
                          Pages.tsx: the pages a question goes with, in the composer and its bubble,
                          PagePicker.tsx: the page picker `@` and "+" open,
                          Save.tsx: the buttons that save a reply or the chat to Notion, and why a save failed,
                          Account.tsx: the avatar and its menu, Header.tsx: the header, and a page's,
                          Credits.tsx: the Credits page, History.tsx: the history of the user's credits,
                          Settings.tsx: the Settings page,
                          Model.tsx: the model menu by the composer, and the Settings page's
                          providers and their models, menu.ts: how the panel's menus behave,
                          icons.tsx: the Cofun mark and the icons, style.css: the look)
  test/                   tests of the extension's client code (fake Notion tab with sanitized
                          fixtures), and of the side panel's UI: the whole panel in jsdom
                          (*.test.tsx)
  use-cases/              Notico's use cases (UC-NOTICO-…), by domain; tests are named with their
                          scenario IDs (docs/bdd.md)
worker/                   Cloudflare Worker
  src/app.ts              the Hono app, composed from the sub-apps below; everything under /v1 is one
                          sub-app whose first handler is the session check
  src/http.ts             what every route shares: bindings, options, errors, and request parsing
  src/routes/             the routes, by area, each a Hono sub-app:
    session.ts            Clerk JWT verification, the first handler under /v1
    rate-limit.ts         the default per-user rate limit of every route under /v1 but the chat
    chat.ts               /v1/chat/completions, charged to credits (chat-request.ts: what a request may hold)
    credits.ts            the user's own credits and their history (/v1/credits…)
    billing.ts            buying credits (/v1/billing/*), Checkout's return pages, and /stripe/webhook
    admin.ts              the admin routes (/v1/admin/*)
    pages.ts              the sign-in page, the admin page, /health, and / (a redirect to /login)
  src/credits.ts          credit ledger over D1: grants, expiry, spending, model calls and their cost
  src/billing.ts          the packs on offer, and what the Stripe webhook does with each event
  src/stripe.ts           Stripe's API (Checkout Sessions), webhook signatures, and the events' shapes
  src/billing-page.ts     the page Checkout sends a buyer back to
  src/pricing.ts          what each model's tokens cost in credits
  src/usage.ts            per-request usage records (Workers Analytics Engine), no message content
  src/analytics.ts        the purchase event sent to PostHog when a payment adds credits
  src/login.ts            sign-in page (Clerk Sync Host)
  src/admin.ts            admin page: credits granted and spent as a whole, one account's credits, grants by hand
  src/overview.ts         what was granted and spent in a period across accounts, read from the ledger's tables
  migrations/             the D1 schema (grants, model_calls), applied on deploy
  test/                   REST integration tests (real signed JWTs, fake AI binding, fake Stripe with
                          webhook events signed like Stripe's, the real SQL on SQLite behind a fake D1),
                          and the extension's agent run against the worker
  use-cases/              the rules only the worker decides, whichever extension asks, and the
                          backend's own use cases (UC-COFUN-…), by domain
e2e/                      pnpm e2e: drives the shared Chrome Canary over CDP for ai-e2e runs
                          (maintainer's machine only; its unit tests run in pnpm test)
smoke/                    pnpm smoke: loads the built extension into Chromium and checks that it
                          still works (Notion and Clerk answered from fixtures; runs in CI)
docs/
  architecture.md         this file
  development.md          setup, deployment, and repository settings
  security.md             the security model: what is protected, how, the trade-offs accepted, and
                          the rules later changes are checked against
  assets/                 pictures used by Notico's README.md
  bdd.md                  how use cases and scenarios are written, and how to run ai-e2e scenarios
.oxlintrc.json            lint rules, including the extensions' module boundaries
.github/rulesets/         GitHub branch rulesets (export format)
.github/workflows/        CI, CodeQL, dependency review, workflow lint, Claude review, and Claude on request
.github/dependabot.yml    weekly dependency updates
scripts/
  sync-github-settings.sh applies the rulesets and repository options with gh
  check-use-cases.ts      pnpm use-cases (run by pnpm check): every ✅ api-test scenario has a test;
                          the check itself is in use-cases.ts, with its unit tests in test/
README.md                 Cofun and its extensions, for users
PRIVACY.md                what the sign-in and the worker do with users' data, for every extension
AGENTS.md                 development workflow and conventions (CLAUDE.md links here)
```
