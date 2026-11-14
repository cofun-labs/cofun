# Security model

What Cofun protects, who it protects it from, and how each part does so. It describes the design, not a list of bugs: a weakness that can be used is reported privately and fixed, not written here. The trade-offs the design accepts on purpose are named, with the reason for each.

A change that touches one of the areas below is checked against this file, and updates it in the same PR when it changes what is said here (see [Rules for later changes](#rules-for-later-changes)). It was first written from a review of the code and its tests in November 2026 ([#107](https://github.com/cofun-labs/cofun/issues/107)).

## What is protected, and from whom

- **The user's Notion workspace**: what it says, that it changes only as the user wants, and the account's standing with Notion (the tools call Notion's internal API as the user).
- **What is on the device**: chats (which hold Notion content the agent read), the sign-in, and the user's own model keys.
- **The account and its credits**: nobody else reads them or spends them.
- **The operator's side**: the hosted model's cost, the Stripe, Clerk, and Cloudflare accounts, and the right to publish the extension.

| Who | What they control |
|---|---|
| Someone who can put text where the agent reads it | A page shared with the user, a block or a row in a page they can edit, a page title, a comment, a search result. They need no Cofun account and no access to the user's machine |
| A website the user visits | Its own pages, the cross-origin requests a browser makes from them, and its tab's title and URL, which the model can ask for |
| A signed-in Cofun user | Their own session token: any request to the worker under their own account |
| Anyone on the internet | Requests to the worker's routes that need no session |
| A contributor to the public repository | Issues, comments, and pull requests from forks |

Outside the model: someone who already has the user's Chrome profile (the privacy pages say what is kept there, unencrypted), and Notion, Clerk, Stripe, Cloudflare, or a model provider being compromised themselves. Dependencies are limited by the lockfile, dependency review in CI, and Dependabot.

## The agent and Notion

The agent loop and its tools run in the side panel. The model sees the system prompt, the conversation, and what the tools return; it acts only through the tools.

- **Text the user did not write is data.** That is what the tools return from Notion and, from any site, the current tab's title and URL (`get_current_tab`); no tool reads another site's content. The system prompt says so, and comments, which anyone who can open a page may write, are quoted so one cannot pass for the tool's own words (`src/notion/comments.ts`). This guides the model; it does not bind it, which is why the limits below are in code.
- **What the model can do is the tool list.** Each tool's arguments are parsed with its zod schema before anything runs (`src/tool.ts`). In Read only, the tools that change data are not offered to the model at all (`src/agent/agent.ts`). Moving pages to the trash asks the user each time, naming each page. Saving a chat to Notion is the user's own action, not a tool.
- **Nothing the model writes becomes a request to a host it chose.** The tools call Notion only. What they write is text, and links with `http:`, `https:`, `mailto:`, or a Notion path; no image, embed, bookmark, or file, and icons are emoji, so nothing written makes Notion or a reader's browser fetch an outside address by being looked at (`src/notion/blocks.ts`, `src/tools/write.ts`). In the panel, a reply is rendered as React elements with no HTML, and its images are never loaded (`src/sidepanel/Markdown.tsx`).
- **One question is bounded**: ten model turns, 50 pages per bulk call, and 100 Notion requests before the user is asked whether to go on. A rate limit from Notion stops the question; nothing is retried or worked around ([AGENTS.md](../AGENTS.md), "Calling Notion").
- **Only the active tab, only on Notion.** Requests run inside the user's Notion tab, to that tab's own origin, after checking it is still on a Notion host, and redirects are not followed (`src/notion/tab.ts`).
- **A saved chat is parsed when read back**; one that does not parse is never opened or sent to the model (`src/sessions.ts`).

### Accepted: writes without approval

Apart from the trash, the agent changes Notion without asking first. Text it reads that the user did not write can carry an instruction, and a model may follow it: it could change pages, move a private page under a shared one, or write what the user can see where someone else can read it; a comment or a mention also notifies other people. The user sees every change on its tool card, and Notion's page history can undo it, though not what someone read meanwhile. This is the product's main risk. It is stated to users in [Notico's README](../extensions/notico/README.md) and in [architecture.md](architecture.md#writes-without-approval), Read only is the switch for a user who does not accept it, and [#388](https://github.com/cofun-labs/cofun/issues/388) narrows what runs unasked.

A link is the one way written content can carry data out: only when someone clicks it.

## The extension

- **Permissions** are `sidePanel`, `storage`, `tabs`, `cookies`, and `scripting`, with host access to Notion, the worker, Clerk, and the sign-in's parent domain (`*.cofun.cc`, to see one Clerk cookie). `extensions/notico/test/manifest.test.ts` pins them and the content security policy, so neither changes unnoticed.
- **No way into the extension's code from a page.** There is no content script, no `externally_connectable`, no web-accessible resource, and no message listener: a web page, Notion included, has no channel to the side panel or the service worker. What a page can reach is the model, as text a tool returns (above).
- **Code in the Notion tab** runs with `chrome.scripting` in the ISOLATED world, out of the page's reach. The injected functions are fixed; the model's arguments reach them only as the JSON body of a request to a fixed list of Notion endpoints.
- **The content security policy** lets the extension's pages run only their own scripts and connect only to the hosts in the [privacy page](../extensions/notico/PRIVACY.md#where-data-goes). No remote code is loaded.
- **Module boundaries are lint errors** (`.oxlintrc.json`): where `fetch` and `chrome.scripting` may be used, and `chrome.debugger` nowhere.
- **A user's own model** is asked from the extension directly: the key goes only to the service it belongs to, and so does the conversation, Notion content included, in place of the worker. What the worker section says does not apply to it; the provider is the user's choice.

### Accepted: nothing on the device is encrypted

Chats, the Clerk client token, and the user's model keys are kept in the Chrome profile, unencrypted; chats and keys stay after sign-out. A key kept in the same profile would not protect them from someone who has the profile. The privacy page says so.

## Sign-in and the worker

- **Every route under `/v1` needs a session.** The session check is the first handler of the `/v1` sub-app, so a route cannot be added without it; `worker/test/session.test.ts` checks every route. The token is verified with the Clerk instance's public key, with no call to Clerk, and a token issued to an origin must name an allowed one (`worker/src/routes/session.ts`).
- **Authentication is the bearer token, never a cookie**, so a cross-origin page gains nothing by calling, and CORS can allow any origin.
- **A user reaches only their own account.** No route takes a user id from the request except the admin's.
- **Admin routes** need the `admin` role in the token, which comes from Clerk metadata users cannot write, and a token issued to the worker's own origin. Everything else gets one and the same refusal. Hand grants are bounded and logged with the admin's id (`worker/src/routes/admin.ts`).
- **The model is the worker's choice.** A request naming another is refused, and only the fields the model needs are passed on. Calls are charged to the user's credits and rate limited per user ([architecture.md](architecture.md#credits)).
- **Payments.** A Stripe event counts only with Stripe's signature, made within five minutes. What is granted is what Stripe says was sold, for the user and pack the worker itself wrote on the Checkout Session, and each payment grants once and is taken back once, in whatever order events arrive (`worker/src/stripe.ts`, `worker/src/billing.ts`).
- **No content is stored or logged.** The ledger and the usage records hold ids, numbers, and times; of an error from a model call or a failed request, a short bounded part is logged; the gateway's logs and cache are off ([PRIVACY.md](../PRIVACY.md)).

## Secrets and the repository

- **What is committed is public by design**: the Clerk publishable key and JWT public key, the extension's public key and ID, the Stripe price id, and domain names. The worker's secrets live on Cloudflare; local ones (`.dev.vars`, `.env.local`, `keys/`) are git-ignored.
- **`main` changes only through pull requests** with CI, dependency review, and workflow lint passing, through a merge queue. Every action is pinned to a commit. GitHub's settings are kept as code (`scripts/sync-github-settings.sh`).
- **Deploys hold no Cloudflare credential on GitHub**: Cloudflare pulls the repository and deploys on merge. The Release workflow uses no secret and ends in a draft release, which a person uploads to the store.
- **One workflow holds a secret and can push**: the one that runs Claude on request (`.github/workflows/claude.yml`). It starts only when the owner, a member, or a collaborator asks. The review workflow runs on `pull_request`, so a fork's pull request gets no secret, and it may only read the diff and comment.
- **The sign-in's domain serves nothing else a browser runs.** The public bucket at `static.cofun.cc` holds images and videos only (`scripts/upload-media.ts`).

## Rules for later changes

A PR is checked against these, beside the reviewer's list in [AGENTS.md](../AGENTS.md).

1. **A new tool that changes data** says in its PR why it may run unasked, or asks first.
2. **A new kind of writable content** (a block type, a property type, an icon or cover by URL) is checked for whether Notion or a reader's browser fetches an address in it without a click. If it does, the model must not be able to choose that address.
3. **A new source of text for the model** (another site, a file, a search, an outside service) is untrusted from its first PR: marked as data for the model, and with a rule for which changes still run unasked once the conversation holds it ([#348](https://github.com/cofun-labs/cofun/issues/348)).
4. **A request to an address, or with arguments, the model writes** (a fetch, a search, a call to an outside service) is a way out for data. It needs a rule in code for what is allowed, checked against the user's own messages, not the model's.
5. **A new host** changes the content security policy, `test/manifest.test.ts`, and the privacy page's table together.
6. **A new way into the extension** (a content script, a message listener, `externally_connectable`, a web-accessible resource) treats what arrives as untrusted, and is described here.
7. **A new route on the worker** goes under `/v1` unless it has its own proof of who is calling, as the Stripe webhook has, and takes a user id from the request only on an admin route.
8. **Anything that costs the operator money** (a model, a search, a fetch) is charged or capped per user before it is offered.
9. **Nothing a browser runs is served from another host under `cofun.cc`.**
10. **A weakness that can be used is not written into a public Issue, PR, or this file.** It goes to the maintainer privately ([#384](https://github.com/cofun-labs/cofun/issues/384) sets up how), and this file changes when the design does.
