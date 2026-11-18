# Confluco privacy

Confluco is a Chrome extension that opens an AI side panel, which can read browser tabs and public web pages and search the web. It is one of the [Cofun](../../README.md) extensions, which share one server and one sign-in. This page says what Confluco reads, where it goes, and what is kept on your device; what the server and the sign-in do with it is on [Cofun's privacy page](../../PRIVACY.md). The two pages together are Confluco's privacy policy. They describe the extension built from this folder with its committed configuration and the worker deployed from `worker/`; if you build it against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including the pages the assistant read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare, or, if you set up your own model on OpenRouter, to OpenRouter with your own key. We do not store that content. Your chats are saved on your device only. Unless you turn it off, Confluco also tells us which of its features are used and whether they worked, never what you asked, what the assistant answered, or anything from your pages.

## What the extension reads

What is read for a question becomes part of **your conversation**, which goes to our worker and the AI model (or to OpenRouter) and is saved with the chat on your device. Your sign-in, credits, OpenRouter key, and usage data never join the conversation.

- **Tab titles and URLs.** The tabs you added to each question, and the current tab when the assistant looks it up. A URL is the whole address, which on some sites holds a sign-in or share token. The page picker reads your tabs' titles and URLs to offer them; they stay in the browser unless you add one.
- **Pages in your tabs, on sites you allowed.** The assistant can read the page in the current tab, and in a tab you added to the chat, only on a site you allowed: Confluco asks you, and Chrome asks again. Until you remove the access in Chrome's extension settings, it may read that site's pages in your tabs when a question needs them, including what the page shows you because you are signed in. It reads the page already open in the tab and sends the site no request. The tab-reading tools skip the hosts Confluco needs for sign-in.
- **Text you send with "Ask Confluco".** When you select text on any page, right-click, and pick "Ask Confluco", the extension reads the selection in that tab, with the page's title and URL. The extension checks the active account with Clerk and keeps the selection in browser session storage for that account until the panel takes it. The text leaves the browser only when you send the question.
- **Web pages and web searches.** When a question needs it, the assistant has our worker read a web page by its address, one you gave, a link it found, or one it thinks of, or search the web with a query it writes, which may hold text from your pages or the conversation. The worker reads only public pages, without your cookies or sign-in, and what comes back joins the conversation. This goes through our worker whichever model answers, except searches once you switch on "Search with DuckDuckGo" in the settings: each then opens DuckDuckGo's results page in a background tab of your browser, which Confluco reads and closes.
- **Your sign-in.** The extension reads the cookies Cofun's sign-in page sets, to know who is signed in, and gets a short-lived session token from Clerk for each request to the worker.
- **Your credits.** To show them, the extension asks the worker, with how far your clock is from UTC; to buy credits, it sends the pack you chose.
- **Your OpenRouter key, if you set one up**, sent only to OpenRouter.
- **Usage data**, unless you turn it off: see [Usage data](#usage-data).

It never reads the content of tabs other than the current one and those you added to a chat, a site you did not allow (other than text you sent with "Ask Confluco"), your browsing history, or what you type outside the side panel.

For a self-managed Confluence site you connect, the assistant can read the published page, search, and browse spaces, page trees, version metadata and text, reported access, labels, comments and replies, and attachment names and links. It can carry editor text you explicitly select and send. The connection uses your browser's existing site session. The assistant can make changes on a direct request. A local file you choose for upload goes to Confluence after confirmation. File bytes are passed directly to the site and are not sent to the model. Attachment names and upload results can be part of the conversation.

For a connected Confluence Cloud site, the assistant can read or search published pages and inspect spaces, page trees, versions, reported access, labels, comments and replies, and attachment metadata and links. When you request a change, Confluco can send a new page title and starting text or a copy of a published page body, a replacement title, edited or restored page text, a label, or a footer comment or reply to that site. A local file you choose for upload goes directly to the connected Cloud site after confirmation. The model can receive the file name and upload result. Requests use the tab's existing Atlassian session. Restoring a page reads and submits the site's confirmation form. Its anti-forgery value stays within the site tab. A verified edit or trash reversal is kept with the local chat.

## Where data goes

The extension contacts the hosts below. Its content security policy limits connections from extension pages. Requests to a connected Confluence site run inside that site's browser tab, and DuckDuckGo's page loads in a tab, as any site does, not from the extension's pages.

| Host                                                         | What is sent                                                                                                                                      | Why                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.cofun.cc` (our worker)                                  | Your session token, the extension's name and version, random ids for the chat and the question, and your conversation so far                      | To get the AI model's reply                                                                                                                                                           |
| `api.cofun.cc` (our worker)                                  | Your session token, the chat and question ids, and the address of a web page or the query of a web search the assistant chose                     | To read the page or make the search, also when your own model answers                                                                                                                 |
| `api.cofun.cc` (our worker)                                  | Your session token, how far your clock is from UTC, and the pack you chose to buy                                                                 | To show your credits and start a checkout                                                                                                                                             |
| `openrouter.ai`, only once you switch it on                  | Your OpenRouter key, to check it and to ask its models; the conversation, when one of its models answers; a request for its public list of models | To answer with the model you chose, under your own account. OpenRouter passes the conversation to the model's provider ([OpenRouter's privacy policy](https://openrouter.ai/privacy)) |
| `us.i.posthog.com` (PostHog), unless you turn usage data off | Usage events, as listed under [Usage data](#usage-data)                                                                                           | To see how Confluco is used and where it fails                                                                                                                                        |
| `html.duckduckgo.com` (DuckDuckGo), only once you switch on "Search with DuckDuckGo" | The query of each web search the assistant makes, which may hold text from your pages or the conversation, as the address of a page your browser opens in a background tab, with your DuckDuckGo cookies, as when you search there yourself; DuckDuckGo sees your IP address | To search the web for free, instead of through our worker. DuckDuckGo says it does not store your searches ([DuckDuckGo's privacy policy](https://duckduckgo.com/privacy)) |
| `clerk.cofun.cc`, `img.clerk.com` (Clerk)                    | Your Clerk session; a request for your avatar                                                                                                     | Sign-in, and showing who is signed in                                                                                                                                                 |
| Your connected Atlassian-hosted Confluence Cloud site | Page, space and comment references, search terms and filters, pagination cursors, requested page titles, starting text, copied and edited page bodies, page restoration form fields, labels, footer comments and replies, a file selected for upload, and the tab's Atlassian session cookies | To read and search published content and apply requested changes using your Atlassian account |
| Your connected self-managed Confluence host | Page references, search terms and filters, requested changes, a file selected for upload, and the tab's Confluence session cookies | To read or change pages and related data using your Confluence account |

The extension also holds a host permission for `*.cofun.cc`, used only to read the cookie that says whether you are signed in. For ordinary browser-tab reads, Confluco reads the page without making a request to that site.

Confluence session cookies stay with the connected host. Tool results go to the model answering the question through the channel listed above. As with any web service, Cloudflare, Clerk, PostHog, and DuckDuckGo (when you search with it) see your IP address; PostHog is told not to work out a location from it, and our project does not keep it.

"Sign in" and "Buy credits" open Cofun's sign-in page and Stripe's Checkout page in a normal tab. What you enter there goes to Clerk or Stripe, never to the extension or the worker; [Cofun's privacy page](../../PRIVACY.md#who-receives-your-data) says more.

## Usage data

Confluco sends usage events to PostHog, so that we can see how it is used: whether people get as far as asking a question, which tools are used and how often they fail, and which of the panel's actions are used. **It is on until you turn it off**: switch off "Share usage data" in the settings. While it is off, the extension sends PostHog nothing, and nothing held back is sent later. The one event our worker sends when a payment adds credits is not covered by this switch ([Cofun's privacy page](../../PRIVACY.md#who-receives-your-data)).

An event says that something happened, never what was written or read: every value in it is a name from a fixed list, a number, or yes/no. These are all the events:

| Event                                                                                                 | What it holds                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The panel was opened; the sign-in page was opened; you signed in                                      | Nothing more                                                                                                       |
| Your device's random id was joined to your account                                                    | The random id and your Clerk user id                                                                               |
| A question was asked                                                                                  | Which service answers (the hosted model or OpenRouter)                                                             |
| A question ended                                                                                      | The same service; how it ended, with our server's error code if it had one; how many model calls and tools it took |
| A tool ran                                                                                            | The tool's name, how it ended                                                                                      |
| The model was switched; a key of your own was saved                                                   | Which service, never the key or the model                                                                          |
| The settings, credits page, or credit history was opened; a pack of credits was chosen                | For a pack, its size                                                                                               |
| A chat was started, opened, or deleted; a page was added to a question; a reply was stopped or copied | For an added page, whether with `@` or "+"                                                                         |

Each event also holds the extension's name and version, the time, a random id of its own and one for the stretch of use it belongs to, our PostHog project's public key, the analytics code's name and version, your browser and operating system, and who it is counted under: a random id made on your device, joined to your Clerk user id once you sign in. It holds no URL, page title, name, email address, or location.

Confluco does not record clicks, keystrokes, or the screen, and loads no code from PostHog. [PostHog's privacy policy](https://posthog.com/privacy) says how PostHog handles what it is sent.

## What stays on your device

- **Your chats**, in your Chrome profile, separately for each signed-in account: what you asked, the replies, and what the assistant read to answer, such as tabs, web pages, and searches; of a long page, its full text. Each chat and each question has a random id, sent to our worker with its requests so that what it spent can be matched to it. Continuing a chat sends the relevant conversation to the model provider. The panel clears full results that are at least seven days old when it opens. It sends parts of a long result to the model when needed.
- **Your sign-in**: Clerk's token that keeps you signed in.
- **Your own model, if you set one up**: your OpenRouter key and the models you chose, for the account that set them up. Removing the key in the settings deletes it.
- **An undo record**, in the local chat, for the latest verified text edit or trash action it can reverse. It holds the page reference, version, and the reversal details.
- **Settings**: the connected Confluence base URL, kept separately per Cofun account and cleared when disconnected, and which Chrome grants came from a connection, so they can be released when no account uses them. Existing site access is kept. Settings also hold the assistant mode (Edit or Read only), whether web searches go to DuckDuckGo, whether usage data is shared, and whether the right-click menu shows "Ask Confluco". That last one is synced to your other devices if you use Chrome sync.
- **DuckDuckGo searches in your Chrome history**, once you switch on "Search with DuckDuckGo": each search opens DuckDuckGo's results page in a tab, so Chrome keeps its address, which holds the query, in your browsing history, as for any page you open, and syncs it to your other devices if you use Chrome sync. Confluco doesn't remove these entries; you can, in Chrome's history. When DuckDuckGo asks you to confirm you are a person, its tab stays open with the query in its address bar.
- **A browser session id**, kept until Chrome closes, to distinguish tabs that are still open from old tabs whose ids Chrome may reuse.
- **Usage ids**: the random id your events are counted under, and your Clerk user id while you are signed in (signing out clears it while usage data is on). After you turn usage data off they stay on the device, even after you sign out, and are sent nowhere.

None of this is **encrypted**, and your chats and OpenRouter key **stay after you sign out**: anyone with access to your Chrome profile can read them. Removing the extension removes it all.

## What is never collected

- No content in usage data: no messages, replies, page titles or URLs, or keys, and you can turn it off.
- No advertising, no tracking across sites, no session recording, and no remote code.
- No browsing history.
- We do not sell your data, or use it for anything but providing the assistant.

## Changes and contact

This page is written by kind of data and by recipient. It changes in the same pull request as a change that adds a kind of data that leaves the browser, a host it goes to, or something kept on your device; its [history](https://github.com/cofun-labs/cofun/commits/main/extensions/confluco/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/cofun-labs/cofun/issues). Report a security vulnerability privately instead, as [SECURITY.md](../../SECURITY.md) says.
