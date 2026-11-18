# Privacy

The Dashboard's Privacy tab. It must agree with [Notico's privacy page](../PRIVACY.md) and [Cofun's](../../../PRIVACY.md), which together are the privacy policy it links to.

## Single purpose

```text
Notico is an AI assistant in Chrome's side panel that reads and edits the user's Notion pages at the user's request, and reads the page the user is on, on a site they allowed, or a web page by its address, and searches the web, when a question needs it.
```

## Permission justifications

One for each permission in the manifest, and one for its host permissions together.

### sidePanel

```text
The extension's whole interface is a side panel, where the user chats with the assistant next to their Notion page.
```

### storage

```text
Keeps the user signed in (the sign-in client token); the user's own OpenRouter key, if they set one up, with the models they switched on and the model chosen in the message box; and small settings: whether the assistant may change the user's pages (Edit or Read only), whether web searches go to DuckDuckGo, and whether usage data is shared. It keeps whether the "Ask Notico" menu item shows, which the user can turn off in the settings, in Chrome's synced storage, so it follows their Chrome profile. While the browser is open, it also holds text the user selected with "Ask Notico" until they send it, and an id for the browser's current run, so a tab added to a question is not mistaken for another after a restart.
```

### tabs

```text
Reads the current tab's URL and title to tell whether it is a Notion page, and to find the Notion tab the assistant works in. A non-Notion tab's URL and title are sent only when the user's question needs them. When the user opens the page picker in the message box, it also reads the URLs and titles of the other tabs that show Notion pages, and of the tabs in the side panel's window that show other sites, to offer them; one is sent only when the user adds it to a question, and a page on another site is read, in the tab, only on a site the user allowed. When the user switched on "Search with DuckDuckGo", each web search opens DuckDuckGo's results page in a background tab, which the extension closes once it has read the results.
```

### cookies

```text
Reads the sign-in cookies that our own sign-in service (Clerk, on cofun.cc) sets, to bring the user's session into the extension and to notice sign-in and sign-out. It reads no cookies of other sites.
```

### scripting

```text
Runs the requests that read and edit Notion pages inside the user's own Notion tab, with that tab's session, so no Notion credentials leave the tab. On another site, and only on one the user allowed, it reads the text of the page in the current tab, or of a tab the user added to the conversation, inside that tab, when the user's question is about that page. When the user picks "Ask Notico" on selected text, it reads that selection in the tab. When the user switched on "Search with DuckDuckGo", it reads the search results in the DuckDuckGo tab a search opens.
```

### contextMenus

```text
Adds an "Ask Notico" item to the menu Chrome shows when the user right-clicks selected text. Picking it opens the side panel with that text added to the user's next question; nothing is sent until the user sends the question.
```

### activeTab

```text
When the user picks the "Ask Notico" menu item, reads the text they selected in that tab, with its line breaks, so it can be added to their question. No site needs to be allowed for it, and nothing else of the page is read.
```

### Host permission

```text
www.notion.so and app.notion.com: to read and edit the user's pages in their Notion tab. api.cofun.cc: our server and sign-in page. clerk.cofun.cc: our sign-in service, whose session cookie the extension reads to sign the user in. *.cofun.cc: only to read the sign-in cookie that the sign-in service sets on the parent domain. Optional host permissions for http and https sites: none is granted at install. When the user asks about the page they are on, the side panel asks them to allow that one site, and Chrome asks them again; only then is the page's text read, in the tab. When the user adds a tab on a site not allowed yet to a conversation, Chrome asks them to allow that one site. html.duckduckgo.com, only when the user switches on "Search with DuckDuckGo" in the settings, which asks Chrome for it: each web search then opens DuckDuckGo's results page in a background tab, and the extension reads the results in that tab and closes it, free, instead of searching through our server.
```

## Remote code

No, I am not using remote code. Everything the extension runs is in its package; its content security policy allows scripts only from the extension itself (`script-src 'self'`).

## Data usage

| Category | Collected | Why |
|---|---|---|
| Personally identifiable information | Yes | The account's name, email address, and avatar, shown in the panel |
| Health information | No | |
| Financial and payment information | Yes | Each purchase of credits, kept by the worker under the account's id with its Stripe payment reference and whether it was refunded or disputed. Card details go to Stripe's Checkout page, never to the extension or the worker. When a payment adds credits, the worker also tells PostHog that a purchase was completed, with the account's id and the pack chosen, and no amount, currency, or payment reference; this comes from the worker, so the extension's usage-data switch does not cover it |
| Authentication information | Yes | The Clerk session token and cookie, and the user's own OpenRouter key, which is sent only to OpenRouter |
| Personal communications | Yes | The user's conversation with the assistant goes to the worker and the model, or to OpenRouter when the user answers with their own model, and to the user's own Notion workspace when the user saves a chat or a reply there. A summary of a long chat is kept with that chat on the device and sent to the selected model when the chat continues |
| Location | No | The clock's offset from UTC is sent to count credits used per day; it is not a location |
| Web history | Yes | A tab's URL and title, when a question needs them; the URL and title of a Notion page open in another tab, or of a tab on another site, that the user adds to a question; and the address of a web page the assistant reads, which goes to the worker, which reads it; and, when the user switched on "Search with DuckDuckGo", the address of each search's DuckDuckGo results page, which holds the query and which Chrome keeps in the user's browsing history as for any page opened in a tab |
| User activity | Yes | Usage events sent to PostHog, unless the user turns them off in the settings: that the panel was opened, a question asked and how it ended, which tools ran, and which of the panel's actions were used. Names from a fixed list, counts, and yes/no values only: no text typed, no page content, title, or URL, no clicks or keystrokes recorded |
| Website content | Yes | The Notion content the assistant reads; the text of a page on another site it reads (the current tab or a tab the user added, on a site they allowed); text the user selected on a page and sent with "Ask Notico"; the text of a web page it read by its address; and the queries of web searches it makes, which may hold Notion content, with their results (each one's address, title, and description). All go to the worker and the model, or to OpenRouter when the user answers with their own model; a page read by its address goes through the worker either way, and a search's query goes through the worker on to Cloudflare's Web Search and its provider, or, when the user switched on DuckDuckGo in the settings, to DuckDuckGo as a page the browser opens in a tab |

All three certifications are checked: no selling or transfer of user data to third parties outside the approved use cases, no use or transfer for purposes unrelated to the single purpose, and none to determine creditworthiness or for lending.

## Privacy policy URL

```text
https://github.com/cofun-labs/cofun/blob/main/extensions/notico/PRIVACY.md
```
