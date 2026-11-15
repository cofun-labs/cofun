# Security model

What Cofun protects, who it protects it from, and how each part does so. It describes the design, not a list of bugs: a weakness that can be used is [reported privately](../SECURITY.md) and fixed, not written here. The trade-offs the design accepts on purpose are named, with the reason for each.

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

- **Text the user did not write is data.** That is what the tools return from Notion, from any site the current tab's title and URL (`get_current_tab`), and from another site the text of the page in the current tab (`read_current_tab`). The system prompt says so, comments, which anyone who can open a page may write, are quoted so one cannot pass for the tool's own words (`src/notion/comments.ts`), and a line of another site's page that opens like one of the tool's own notes is escaped (`src/tools/current.ts`). This guides the model; it does not bind it, which is why the limits below are in code.
- **What the model can do is the tool list.** Each tool's arguments are parsed with its zod schema before anything runs (`src/tool.ts`). In Read only, the tools that change data are not offered to the model at all (`src/agent/agent.ts`). Moving pages to the trash asks the user each time, naming each page. Saving a chat to Notion is the user's own action, not a tool.
- **Nothing the model writes becomes a request to a host it chose.** The tools call Notion only. What they write is text, and links with `http:`, `https:`, `mailto:`, or a Notion path; no image, embed, bookmark, or file, and icons are emoji, so nothing written makes Notion or a reader's browser fetch an outside address by being looked at (`src/notion/blocks.ts`, `src/tools/write.ts`). In the panel, a reply is rendered as React elements with no HTML, and its images are never loaded (`src/sidepanel/Markdown.tsx`).
- **A web page only at an address the user wrote.** `read_web_page` and `render_web_page` take an address from the model, so they are a way out for data (rule 4 below): each reads only an address written whole in one of the user's own messages in the chat, never in a note the panel adds, a tool's result, or the model's words, refuses one the model changed in any part, and sends the address as the user wrote it, not as the model did, so the model can't carry data in which characters it encodes or which scheme it picks (`userAddress` in `src/tools/web.ts`). Errors from the worker that the tool can't act on stop the question: the worker's rate limit, credits that ran out, the site turning requests away for coming too often, and any code the extension doesn't know. A page the worker read is untrusted text like any other site's.
- **One question is bounded**: ten model turns, 50 pages per bulk call, and 100 Notion requests before the user is asked whether to go on. A rate limit from Notion stops the question; nothing is retried or worked around ([AGENTS.md](../AGENTS.md), "Calling outside services").
- **Only the active tab, only on Notion.** Requests run inside the user's Notion tab, to that tab's own origin, after checking it is still on a Notion host, and redirects are not followed (`src/notion/tab.ts`).
- **Another site only once the user allowed it.** `read_current_tab` reads the top frame of the active tab, on a site whose origin the user allowed with a click in the side panel and in Chrome's own prompt (`src/web/tab.ts`). Chrome takes that request only during a user's click, so the model can't grant a site, and the tool takes no address: it reads only the tab the user is on, never a link found in a page. It sends no request to the site.
- **A saved chat is parsed when read back**; one that does not parse is never opened or sent to the model (`src/sessions.ts`).

### Accepted: writes without approval

Apart from the trash, the agent changes Notion without asking first. Text it reads that the user did not write can carry an instruction, and a model may follow it: it could change pages, move a private page under a shared one, or write what the user can see where someone else can read it; a comment or a mention also notifies other people. The user sees every change on its tool card, and Notion's page history can undo it, though not what someone read meanwhile. The same holds once the conversation holds text from another site the assistant read (`read_current_tab`): changes still run unasked, as after reading a page someone else wrote in Notion; [#348](https://github.com/cofun-labs/cofun/issues/348) records asking first instead. This is the product's main risk. It is stated to users in [Notico's README](../extensions/notico/README.md) and in [architecture.md](architecture.md#writes-without-approval), Read only is the switch for a user who does not accept it, and [#388](https://github.com/cofun-labs/cofun/issues/388) narrows what runs unasked.

A link is the one way written content can carry data out: only when someone clicks it.

## The extension

- **Permissions** are `sidePanel`, `storage`, `tabs`, `cookies`, and `scripting`, with host access to Notion, the worker, Clerk, and the sign-in's parent domain (`*.cofun.cc`, to see one Clerk cookie), and any web site as an optional host permission, granted one origin at a time when the user allows it. `extensions/notico/test/manifest.test.ts` pins them and the content security policy, so neither changes unnoticed.
- **No way into the extension's code from a page.** There is no content script, no `externally_connectable`, no web-accessible resource, and no message listener: a web page, Notion included, has no channel to the side panel or the service worker. What a page can reach is the model, as text a tool returns (above).
- **Code in the user's tabs** runs with `chrome.scripting` in the ISOLATED world, out of the page's reach. The injected functions are fixed. In the Notion tab, the model's arguments reach them only as the JSON body of a request to a fixed list of Notion endpoints; on another site the function only reads the page's text, and takes no argument from the model.
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
- **Web pages the worker reads** are public only and never the worker's own: it sends no cookie or credential, and refuses an address on `cofun.cc`, on a local network name, given as an IP address, on another port, or with a user name, also at each redirect, of which it follows five (`worker/src/web.ts`). A Workers subrequest can't reach a private network. A page rendered in Browser Run is loaded by a browser that follows the page's own redirects and loads what it loads, outside these checks: it runs on Cloudflare with no session of ours, so what it can reach is what anyone can. Reads are rate limited per user (`WEB_LIMIT`), and renders, which cost the operator browser time and are free to the user until [#464](https://github.com/cofun-labs/cofun/issues/464), have a much lower cap of their own (`RENDER_LIMIT`).
- **Payments.** A Stripe event counts only with Stripe's signature, made within five minutes. What is granted is what Stripe says was sold, for the user and pack the worker itself wrote on the Checkout Session, and each payment grants once and is taken back once, in whatever order events arrive (`worker/src/stripe.ts`, `worker/src/billing.ts`).
- **No content is stored or logged.** The ledger and the usage records hold ids, numbers, and times; of an error from a model call or a failed request, a short bounded part is logged; the gateway's logs and cache are off ([PRIVACY.md](../PRIVACY.md)).

### Accepted: a session token that names no origin

A token with no `azp` passes the session check, though it does not pass an admin route's. Clerk hands a side panel that just loaded such a token, and keeps it for the panel's first minute. Refusing it would gain little. A token with no `azp` comes only from Clerk's Frontend API, and so does one naming any origin. Outside a browser, whoever holds the user's Clerk client cookie can set any `Origin` and get either. A page in the browser cannot reach the Frontend API's answer at all, as long as two things stay true:

- **Clerk's Frontend API refuses an origin the instance does not allow**: another website, an extension it does not list, and `null` get `origin_invalid`. This is the Clerk instance's configuration, outside this repository.
- **No other host under `cofun.cc` serves code a browser runs** (rule 9 below), since every `cofun.cc` origin is one the Frontend API answers.

## Secrets and the repository

- **What is committed is public by design**: the Clerk publishable key and JWT public key, the extension's public key and ID, the Stripe price id, and domain names. The worker's secrets live on Cloudflare; local ones (`.dev.vars`, `.env.local`, `keys/`) are git-ignored.
- **`main` changes only through pull requests** with CI, dependency review, and workflow lint passing, through a merge queue. Every action is pinned to a commit. GitHub's settings are kept as code (`scripts/sync-github-settings.sh`).
- **Deploys hold no Cloudflare credential on GitHub**: Cloudflare pulls the repository and deploys on merge. The Release workflow uses no secret and ends in a GitHub Release, whose zip a person uploads to the store.
- **No workflow that reads untrusted text can push.** The one secret on GitHub is Claude's token, held by the review workflow alone. It runs on `pull_request`, so a fork's pull request gets no secret, and it may only read the diff and comment. There is no workflow that runs Claude on request with write access.
- **The release zip can be checked.** The Release workflow records the zip's SHA-256 in its run's summary, and the maintainer compares it with the release's zip before uploading that to the store ([release.md](release.md)).
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
10. **A weakness that can be used is not written into a public Issue, PR, or this file.** A weakness only a PR brings in, not yet merged, may be described in that PR, so it gets fixed. A usable one goes to the maintainer privately ([SECURITY.md](../SECURITY.md) says how), and this file changes when the design does.
