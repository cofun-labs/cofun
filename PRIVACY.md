# Privacy

Notico is a Chrome extension that opens an AI side panel in Chrome, which reads and edits your Notion pages with you. This page says what data it reads, where that data goes, and what is kept. It describes the extension built from this repository with its committed configuration (`extension/.env`) and the worker deployed from `worker/`. If you build the extension against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including the Notion content the assistant read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare. We do not store that content on our servers. Your conversations are saved on your device only.

## What the extension reads

- **Notion content, as you.** To answer a question, the assistant calls tools that read from Notion with your own Notion session, in your Notion tab: pages (as text), database rows and properties, comment threads, search results, the list of pages in your workspace, what you have selected in the page, and the names of workspace members when you ask it to mention someone. It reads only what a question needs, and it can read anything your Notion account can. While the current tab is a Notion page, its title and URL are added to every question.
- **Your sign-in session.** You sign in on a web page served by our worker, with [Clerk](https://clerk.com). The extension reads the Clerk session cookies that signing in there sets to know who is signed in, and gets a short-lived session token from Clerk for each request to the worker.
- **The current tab's URL and title.** The side panel opens on every tab, and you can chat on any of them; the Notion tools work only while the current tab is a Notion page (`www.notion.so` or `app.notion.com`). With each question, and each time a Notion tool runs, the extension looks at the URL of the current tab (the active tab of the panel's window) to tell whether it is Notion. On a tab that is not Notion, the question only says that the current tab is not a Notion page. The URL and title of such a tab leave the browser only when the assistant calls its `get_current_tab` tool because a question needs them (say, "save a link to this page in my reading list"): the URL is the whole address, including its query string and fragment, which on some sites hold a sign-in or share token. They are then part of the conversation, which goes to the worker and the model and is saved with the session on your device, as described below.

It never reads the content of other sites, tabs other than the current one, your browsing history, or what you type outside the side panel.

It also writes to Notion when you ask it to: it edits and creates pages, changes properties, adds comments, and moves pages. These changes are requests to Notion, made as you.

## Where data goes

The extension sends requests to these hosts and no others. The extension's content security policy stops its own pages from connecting anywhere else, and a test pins that policy and the hosts the extension has permission for, so neither can change unnoticed.

| Host | What is sent | Why |
|---|---|---|
| `www.notion.so`, `app.notion.com` | Requests to Notion's own API, sent from inside your Notion tab with that tab's session: reads, and the changes you ask for | To read and edit your pages. This is the same service your Notion tab already talks to |
| `notico-api.cofun.cc` (our worker) | Your Clerk session token, and for each question the conversation so far: your messages, the assistant's replies, the tool calls and their results (which contain the Notion content the assistant read), the open Notion page's title and URL, the current tab's title and URL on another site if the assistant looked them up, and the assistant's instructions | To get the AI model's reply |
| `clerk.cofun.cc` (Clerk's Frontend API) | Your Clerk session, to load your account and get session tokens | Sign-in |
| `img.clerk.com` (Clerk's image host) | A request for your account's avatar image | To show who is signed in |

The extension also holds a host permission for `*.cofun.cc`. It uses it for nothing but reading one cookie, and sends no requests to any host under it other than the worker and Clerk's Frontend API above: Chrome only lets an extension see a cookie when it has permission for the cookie's domain, and Clerk sets the cookie that says whether you are signed in on the sign-in page's parent domain.

Notion content never goes to Clerk. Your Notion session is never sent anywhere but Notion: requests to Notion are made inside your Notion tab, and the worker and Clerk do not receive your Notion cookies or credentials. The extension reads your Notion user id from the tab to make changes as you.

As with any web service, Cloudflare (which runs the worker) and Clerk see your IP address when the extension connects to them.

### The sign-in page

"Sign in" opens `https://notico-api.cofun.cc/login` in a normal tab. That page runs Clerk's sign-in code, loaded from Clerk's Frontend API (`clerk.cofun.cc`). What you enter there (an email address, or a Google sign-in) goes to Clerk and to the sign-in provider you choose, not to our worker. Clerk holds your account: your email address, name, and avatar as the sign-in provider gives them. See [Clerk's privacy policy](https://clerk.com/legal/privacy).

## What the worker does with it

The worker is the code in [`worker/`](worker/), running on Cloudflare Workers.

- **It checks who you are.** It verifies the session token with Clerk's public key, without calling Clerk, and uses only your Clerk user id from it. For the operators' admin page it also reads the token's `role`, which says whether the account is an operator's; for every other account it is empty.
- **It passes the conversation to the model and streams the reply back.** The model runs on Cloudflare's [Workers AI](https://developers.cloudflare.com/workers-ai/), reached through Cloudflare's AI Gateway. The gateway's log collection and cache are turned off for these requests, so it does not keep your messages or the replies; it keeps request analytics (counts, tokens, cost) tagged with your Clerk user id. The worker itself does not store or log the conversation. Cloudflare processes it to run the model; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **It keeps your credits.** Using the assistant costs credits, and every account gets free credits each week. The worker keeps them in a database on Cloudflare ([D1](https://developers.cloudflare.com/d1/)), by Clerk user id: each grant of credits you were given (how many, how many are left, when they were granted and when they expire, and whether they were the free weekly grant or credits an operator granted you by hand, with that operator's Clerk user id), and one record for each call to the AI model your questions made, whether it was answered or failed: when it started and ended, the model, whether the reply was streamed, how it ended and why the model stopped, the number of input tokens (with how many the model read from its cache) and output tokens (and whether they are an estimate, for a reply that was cut short), and the credits it cost. It holds numbers, times, the model's name, and those ids only, never what you asked or what the assistant answered. Grants and model calls are kept without an end date, after grants expire too, as the record of what the account was given, asked of the model, and spent. Operators of the service can look at an account's credits by its Clerk user id, and grant it credits, and can total grants and model calls across accounts and list accounts, by Clerk user id, with what each was granted and spent.
- **It writes one usage record per chat request.** The record holds your Clerk user id, the model, whether the reply was streamed, the outcome, the finish reason, the number of messages, the size of the input in characters, the token counts (with how many of the input tokens the model read from its cache), the credits charged, and the duration. It never holds message or reply text. Records are kept in Cloudflare Workers Analytics Engine, which deletes them after 90 days.
- **Cloudflare keeps the worker's logs.** These are the request logs Cloudflare records for every Worker (such as the time, URL, and status of a request) and the errors the worker prints when a request fails. The worker does not write the conversation to them. When a model call fails, before or partway through a reply, the credit ledger fails, or a request fails in a way the worker did not expect, it logs only the first 60 characters of the error's name and the first 200 characters of its message, never the whole error: if the model provider's error quoted part of a request, no more than that could reach the logs. When the usage record fails, it logs that error whole; it is never given the conversation. When an operator grants credits by hand, it logs the operator's Clerk user id, the account's Clerk user id, the number of credits, and when they expire.

## What stays on your device

- **Your conversations.** Sessions are saved in the extension's IndexedDB storage in your Chrome profile, one database per signed-in account. They include tool results, such as the content of Notion pages the assistant read, and the URL and title of a tab it looked up. They are not sent to our servers, except that continuing a conversation sends it to the worker again as described above. They are **not encrypted** and they **stay after you sign out**, so that you can pick up again: anyone with access to your Chrome profile can read them. Deleting a session in the side panel removes it; removing the extension removes them all.
- **Your sign-in.** Clerk's code in the extension keeps its client token, which keeps you signed in, in the extension's local storage (`chrome.storage.local`). It is not encrypted either.
- **Small settings.** The extension's local storage also holds the time until which it waits after Notion turned a request away.

## What is never collected

- No analytics, advertising, or tracking in the extension. It loads no remote code.
- The worker does not store Notion content, messages, or replies, and does not write them to its logs (of a failed model call or an unexpected failure it logs only a short, bounded part of the error, as described above).
- No Notion credentials or cookies are sent to the worker or to Clerk.
- No browsing history, and no content of other sites. Of a tab that is not Notion, only its URL and title can leave the browser, only for the current tab, and only when the assistant looks them up to answer a question.
- We do not sell your data, and we do not use it for anything other than providing the assistant.

## Changes and contact

This file changes in the same pull request as any change to what data leaves the browser or where it goes; its [history](https://github.com/cofun-labs/notico/commits/main/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/cofun-labs/notico/issues).
