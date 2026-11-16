# Notico privacy

Notico is a Chrome extension that opens an AI side panel, which reads and edits your Notion pages with you, and can read the page you are on when it is another site, read web pages, and search the web. It is one of the [Cofun](../../README.md) extensions, which share one server and one sign-in. This page says what Notico reads, where it goes, and what is kept on your device; what the server and the sign-in do with it is on [Cofun's privacy page](../../PRIVACY.md). The two pages together are Notico's privacy policy. They describe the extension built from this folder with its committed configuration and the worker deployed from `worker/`; if you build it against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including the Notion content and other pages the assistant read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare, or, if you set up your own model on OpenRouter, to OpenRouter with your own key. We do not store that content. Your chats are saved on your device only. Unless you turn it off, Notico also tells us which of its features are used and whether they worked, never what you asked, what the assistant answered, or anything from your pages.

## What the extension reads

What is read for a question becomes part of **your conversation**, which goes to our worker and the AI model (or to OpenRouter) and is saved with the chat on your device. Your sign-in, credits, OpenRouter key, and usage data never join the conversation.

- **Notion content, as you.** The assistant reads what a question needs from Notion, with your own Notion session in your Notion tab: pages, databases, comments, search results, your workspace's pages and members, and what you selected. It can read anything your Notion account can. Text you type in the page picker is sent to Notion's search.
- **Changes to Notion, as you.** When you ask, it edits, creates, and moves pages, changes properties, and adds comments; saving a reply or a chat creates a Notion page. These are requests to Notion from your Notion tab.
- **Tab titles and URLs.** With each question: the open Notion page's, the pages and tabs you added to it, and the current tab's when the assistant looks it up. A URL is the whole address, which on some sites holds a sign-in or share token. The page picker reads your tabs' titles and URLs to offer them; they stay in the browser unless you add one.
- **Pages in your tabs, on sites you allowed.** The assistant can read the page in the current tab, and in a tab you added to the chat, only on a site you allowed: Notico asks you, and Chrome asks again. Until you remove the access in Chrome's extension settings, it may read that site's pages in your tabs when a question needs them, including what the page shows you because you are signed in. It reads the page already open in the tab: no request is sent to the site.
- **Text you send with "Ask Notico".** When you select text on any page, right-click, and pick "Ask Notico", the extension reads the selection in that tab, with the page's title and URL. It waits in the message box, in the browser's memory, and leaves the browser only with the next question you send.
- **Web pages and web searches.** When a question needs it, the assistant has our worker read a web page by its address, one you gave, a link it found, or one it thinks of, or search the web with a query it writes, which may hold text from your pages or the conversation. The worker reads only public pages, without your cookies or sign-in, and what comes back joins the conversation. This goes through our worker whichever model answers.
- **Your sign-in.** The extension reads the cookies Cofun's sign-in page sets, to know who is signed in, and gets a short-lived session token from Clerk for each request to the worker.
- **Your credits.** To show them, the extension asks the worker, with how far your clock is from UTC; to buy credits, it sends the pack you chose.
- **Your OpenRouter key, if you set one up**, sent only to OpenRouter.
- **Usage data**, unless you turn it off: see [Usage data](#usage-data).

It never reads tabs other than the current one and those you added to a chat, a site you did not allow (other than text you sent with "Ask Notico"), your browsing history, or what you type outside the side panel.

## Where data goes

The extension contacts these hosts and no others; its content security policy stops its pages from connecting anywhere else.

| Host | What is sent | Why |
|---|---|---|
| `www.notion.so`, `app.notion.com` | Requests to Notion's API, from inside your Notion tab with its session | To read and change your pages |
| `api.cofun.cc` (our worker) | Your session token, the extension's name and version, random ids for the chat and the question, and your conversation so far | To get the AI model's reply |
| `api.cofun.cc` (our worker) | Your session token, the chat and question ids, and the address of a web page or the query of a web search the assistant chose | To read the page or make the search, also when your own model answers |
| `api.cofun.cc` (our worker) | Your session token, how far your clock is from UTC, and the pack you chose to buy | To show your credits and start a checkout |
| `openrouter.ai`, only once you switch it on | Your OpenRouter key, to check it and to ask its models; the conversation, when one of its models answers; a request for its public list of models | To answer with the model you chose, under your own account. OpenRouter passes the conversation to the model's provider ([OpenRouter's privacy policy](https://openrouter.ai/privacy)) |
| `us.i.posthog.com` (PostHog), unless you turn usage data off | Usage events, as listed under [Usage data](#usage-data) | To see how Notico is used and where it fails |
| `clerk.cofun.cc`, `img.clerk.com` (Clerk) | Your Clerk session; a request for your avatar | Sign-in, and showing who is signed in |

The extension also holds a host permission for `*.cofun.cc`, used only to read the cookie that says whether you are signed in. A site you allow is not on this list: Notico reads its pages in your tab and sends it nothing.

Your Notion session never leaves Notion, and Notion content never goes to Clerk. Your OpenRouter key goes only to OpenRouter. As with any web service, Cloudflare, Clerk, and PostHog see your IP address; PostHog is told not to work out a location from it, and our project does not keep it.

"Sign in" and "Buy credits" open Cofun's sign-in page and Stripe's Checkout page in a normal tab. What you enter there goes to Clerk or Stripe, never to the extension or the worker; [Cofun's privacy page](../../PRIVACY.md#who-receives-your-data) says more.

## Usage data

Notico sends usage events to PostHog, so that we can see how it is used: whether people get as far as asking a question, which tools are used and how often they fail, and which of the panel's actions are used. **It is on until you turn it off**: switch off "Share usage data" in the settings. While it is off, nothing is sent to PostHog, and nothing held back is sent later.

An event says that something happened, never what was written or read: every value in it is a name from a fixed list, a number, or yes/no. These are all the events:

| Event | What it holds |
|---|---|
| The panel was opened; the sign-in page was opened; you signed in | Nothing more |
| Your device's random id was joined to your account | The random id and your Clerk user id |
| A question was asked | Which service answers (the hosted model or OpenRouter), and whether the current tab was a Notion page |
| A question ended | The same service; how it ended, with our server's error code if it had one; how many model calls and tools it took |
| A tool ran | The tool's name, how it ended, and Notion's kind of error if it failed |
| The model was switched; a key of your own was saved | Which service, never the key or the model |
| The settings, credits page, or credit history was opened; a pack of credits was chosen | For a pack, its size |
| A chat was started, opened, or deleted; a page was added to a question; a reply was stopped or copied | For an added page, whether with `@` or "+" |

Each event also holds the extension's name and version, the time, a random id of its own and one for the stretch of use it belongs to, our PostHog project's public key, the analytics code's name and version, your browser and operating system, and who it is counted under: a random id made on your device, joined to your Clerk user id once you sign in. It holds no URL, page title, name, email address, or location.

Notico does not record clicks, keystrokes, or the screen, and loads no code from PostHog. [PostHog's privacy policy](https://posthog.com/privacy) says how PostHog handles what it is sent.

## What stays on your device

- **Your chats**, in your Chrome profile, separately for each signed-in account: what you asked, the replies, and what the assistant read to answer, such as Notion pages, tabs, web pages, and searches; of a long page, its full text. Each chat and each question has a random id, sent to our worker with its requests so that what it spent can be matched to it. Chats are not sent to our servers, except that continuing a chat sends it to the worker again.
- **Your sign-in**: Clerk's token that keeps you signed in.
- **Your own model, if you set one up**: your OpenRouter key and the models you chose, for the account that set them up. Removing the key in the settings deletes it.
- **Settings**: whether the assistant may change your pages (Edit or Read only), whether usage data is shared, and whether the right-click menu shows "Ask Notico". That last one is synced to your other devices if you use Chrome sync.
- **Usage ids**, while usage data is on: the random id your events are counted under, and your Clerk user id once you sign in.

None of this is **encrypted**, and it **stays after you sign out**: anyone with access to your Chrome profile can read it, your OpenRouter key included. Removing the extension removes it all.

## What is never collected

- No content in usage data: no messages, replies, Notion content, page titles or URLs, or keys, and you can turn it off.
- No advertising, no tracking across sites, no session recording, and no remote code.
- No Notion credentials or cookies sent to the worker or to Clerk.
- No browsing history.
- We do not sell your data, or use it for anything but providing the assistant.

## Changes and contact

This page is written by kind of data and by recipient. It changes in the same pull request as a change that adds a kind of data that leaves the browser, a host it goes to, or something kept on your device; its [history](https://github.com/cofun-labs/cofun/commits/main/extensions/notico/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/cofun-labs/cofun/issues). Report a security vulnerability privately instead, as [SECURITY.md](../../SECURITY.md) says.
