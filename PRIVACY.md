# Privacy

Copilot for Notion is a Chrome extension that opens an AI side panel next to your Notion pages. This page says what data it reads, where that data goes, and what is kept. It describes the extension built from this repository with its committed configuration (`extension/.env`) and the worker deployed from `worker/`. If you build the extension against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including the Notion content the assistant read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare. We do not store that content on our servers. Your conversations are saved on your device only.

## What the extension reads

- **Notion content, as you.** To answer a question, the assistant calls tools that read from Notion with your own Notion session, in your Notion tab: pages (as text), database rows and properties, comment threads, search results, the list of pages in your workspace, what you have selected in the page, and the names of workspace members when you ask it to mention someone. It reads only what a question needs, and it can read anything your Notion account can. The title and URL of the page open in the current tab are added to every question.
- **Your sign-in session.** You sign in on a web page served by our worker, with [Clerk](https://clerk.com). The extension reads the Clerk session cookies of that page to know who is signed in, and gets a short-lived session token from Clerk for each request to the worker.

The side panel works only on Notion tabs (`www.notion.so` and `app.notion.com`). The extension does not read other sites, your browsing history, or what you type outside the side panel.

It also writes to Notion when you ask it to: it edits and creates pages, changes properties, adds comments, and moves pages. These changes are requests to Notion, made as you.

## Where data goes

The extension sends requests to these hosts and no others. The list is [`extension/allowed-hosts.json`](extension/allowed-hosts.json); a test fails when the extension's manifest or configuration names a host that is not on it, and the extension's content security policy stops its pages from connecting anywhere else.

| Host | What is sent | Why |
|---|---|---|
| `www.notion.so`, `app.notion.com` | Requests to Notion's own API, sent from inside your Notion tab with that tab's session: reads, and the changes you ask for | To read and edit your pages. This is the same service your Notion tab already talks to |
| `notion-copilot.kitfun.cc` (our worker) | Your Clerk session token, and for each question the conversation so far: your messages, the assistant's replies, the tool calls and their results (which contain the Notion content the assistant read), the open page's title and URL, and the assistant's instructions | To get the AI model's reply |
| `saving-yeti-9519.clerk.accounts.dev` (Clerk's Frontend API) | Your Clerk session, to load your account and get session tokens | Sign-in |
| `img.clerk.com` (Clerk's image host) | A request for your account's avatar image | To show who is signed in |

The extension also holds a host permission for `*.kitfun.cc` and sends nothing there: Chrome only lets an extension see a cookie when it has permission for the cookie's domain, and Clerk sets the cookie that says whether you are signed in on the sign-in page's parent domain.

Notion content never goes to Clerk. Your Notion session never leaves your Notion tab: the worker and Clerk do not receive your Notion cookies or credentials.

### The sign-in page

"Sign in" opens `https://notion-copilot.kitfun.cc/login` in a normal tab. That page runs Clerk's sign-in code, loaded from Clerk's Frontend API. What you enter there (an email address, or a Google sign-in) goes to Clerk and to the sign-in provider you choose, not to our worker. Clerk holds your account: your email address, name, and avatar as the sign-in provider gives them. While the service uses a Clerk development instance, Clerk's code on that page may also report usage of Clerk's SDK to Clerk's telemetry service; inside the extension that telemetry is turned off. See [Clerk's privacy policy](https://clerk.com/legal/privacy).

## What the worker does with it

The worker is the code in [`worker/`](worker/), running on Cloudflare Workers.

- **It checks who you are.** It verifies the session token with Clerk's public key, without calling Clerk, and uses only your Clerk user id from it.
- **It passes the conversation to the model and streams the reply back.** The model runs on Cloudflare's [Workers AI](https://developers.cloudflare.com/workers-ai/), reached through Cloudflare's AI Gateway. The gateway's log collection and cache are turned off for these requests, so it does not keep your messages or the replies; it keeps request analytics (counts, tokens, cost) tagged with your Clerk user id. The worker itself does not store or log the conversation. Cloudflare processes it to run the model; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **It counts your requests.** A daily counter per Clerk user id (the day and the number of requests) enforces the daily quota.
- **It writes one usage record per chat request.** The record holds your Clerk user id, the model, whether the reply was streamed, the outcome, the finish reason, the number of messages, the size of the input in characters, the token counts, and the duration. It never holds message or reply text. Records are kept in Cloudflare Workers Analytics Engine, which deletes them after 90 days.
- **Cloudflare keeps the worker's logs.** These are the request logs Cloudflare records for every Worker (such as the time, URL, and status of a request) and the errors the worker prints when a model call, the quota check, or a usage record fails. The worker never writes the conversation to them.

## What stays on your device

- **Your conversations.** Sessions are saved in the extension's IndexedDB storage in your Chrome profile, one database per signed-in account. They include tool results, such as the content of Notion pages the assistant read. They are not sent to our servers, except that continuing a conversation sends it to the worker again as described above. They are **not encrypted** and they **stay after you sign out**, so that you can pick up again: anyone with access to your Chrome profile can read them. Deleting a session in the side panel removes it; removing the extension removes them all.
- **Small settings.** The extension's local storage holds the time until which it waits after Notion turned a request away, and a flag that the extension has started in this browser session.

## What is never collected

- No analytics, advertising, or tracking in the extension. It loads no remote code.
- The worker does not store Notion content, messages, or replies, and does not write them to logs.
- No Notion credentials or cookies are sent to the worker or to Clerk.
- No browsing history, and nothing from sites other than Notion.
- We do not sell your data, and we do not use it for anything other than providing the assistant.

## Changes and contact

This file changes in the same pull request as any change to what data leaves the browser or where it goes; its [history](https://github.com/kitfun/notion-copilot/commits/main/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/kitfun/notion-copilot/issues).
