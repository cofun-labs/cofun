# Privacy

The Dashboard's Privacy tab. It must agree with [Confluco's privacy page](../PRIVACY.md) and [Cofun's](../../../PRIVACY.md), which together are the privacy policy it links to.

## Single purpose

```text
Confluco is an AI assistant in Chrome's side panel that reads and searches the user's Confluence pages and changes them on the user's explicit request, and reads the page the user is on, on a site they allowed, or a web page by its address, and searches the web, when a question needs it.
```

## Permission justifications

One for each permission in the manifest, and one for its host permissions together.

### sidePanel

```text
The extension's whole interface is a side panel, where the user chats with the assistant next to the page they are on.
```

### storage

```text
Keeps the user signed in (the sign-in client token); the user's own OpenRouter key, if they set one up, with the models they switched on and the model chosen in the message box; and small settings: whether the assistant may change pages (Edit or Read only), whether web searches go to DuckDuckGo, and whether usage data is shared. It keeps whether the "Ask Confluco" menu item shows in Chrome's synced storage, so it follows the user's Chrome profile. While the browser is open, it also holds text the user selected with "Ask Confluco" until they send it, and an id for the browser's current run, so a tab added to a question is not mistaken for another after a restart.
```

### tabs

```text
Reads the current tab's URL and title to find the page the user is asking about, and to tell whether it is a Confluence page. A tab's URL and title are sent only when the user's question needs them. Each question says only whether the current tab is a Confluence page. When the user opens the page picker in the message box, it reads the URLs and titles of the tabs in the side panel's window to offer them; one is sent only when the user adds it to a question, and its page is read, in the tab, only on a site the user allowed.
```

### cookies

```text
Reads the sign-in cookies that our own sign-in service (Clerk, on cofun.cc) sets, to bring the user's session into the extension and to notice sign-in and sign-out. It reads no cookies of other sites.
```

### scripting

```text
On a site the user allowed, reads the text of the page in the current tab, or of a tab the user added to the conversation, inside that tab; on a YouTube video, it also requests the video's page and transcript from YouTube inside that tab, with its session, as the page does when the user opens the transcript. On a Confluence site the user allowed, runs the requests that read, search, and, when the user asks for a change in so many words, change pages inside the user's own Confluence tab, with that tab's session, so no Confluence credentials leave the tab. With "Search with DuckDuckGo" on, reads the results in the DuckDuckGo tab it opened. When the user picks "Ask Confluco" on selected text, it reads that selection in the tab.
```

### contextMenus

```text
Adds an "Ask Confluco" item to the menu Chrome shows when the user right-clicks selected text. Picking it opens the side panel with that text added to the user's next question; nothing is sent until the user sends the question.
```

### activeTab

```text
When the user picks the "Ask Confluco" menu item, reads the text they selected in that tab, with its line breaks, so it can be added to their question. No site needs to be allowed for it, and nothing else of the page is read.
```

### Host permission

```text
api.cofun.cc: our server and sign-in page. clerk.cofun.cc: our sign-in service, whose session cookie the extension reads to sign the user in. *.cofun.cc: only to read the sign-in cookie that the sign-in service sets on the parent domain. Optional host permissions for http and https sites: none is granted at install. When the user asks about the page they are on, or uses a Confluence site, the side panel asks them to allow that one site, and Chrome asks them again; only then is the site's page read, or Confluence called, in the user's tab. When the user adds a tab on a site not allowed yet, or switches on "Search with DuckDuckGo", Chrome asks them to allow that one site.
```

## Remote code

No, I am not using remote code. Everything the extension runs is in its package; its content security policy allows scripts only from the extension itself (`script-src 'self'`).

## Data usage

| Category | Collected | Why |
|---|---|---|
| Personally identifiable information | Yes | The account's name, email address, and avatar, shown in the panel |
| Health information | No | |
| Financial and payment information | Yes | Each purchase of credits, kept by the worker under the account's id with its Stripe payment reference and whether it was refunded or disputed. Card details go to Stripe's Checkout page, never to the extension or the worker. When a payment adds credits, the worker also tells PostHog that a purchase was completed, with the account's id and the pack chosen, and no amount, currency, or payment reference; this comes from the worker, so the extension's usage-data switch does not cover it |
| Authentication information | Yes | The Clerk session token and cookie, and the user's own OpenRouter key, which is sent only to OpenRouter. Confluence session cookies stay with their site: requests to Confluence run in the user's tab |
| Personal communications | Yes | The user's conversation with the assistant goes to the worker and the model, or to OpenRouter when the user answers with their own model. A summary of a long chat is kept with that chat on the device and sent to the selected model when the chat continues; it may include excerpts from pages read during the chat. Footer comments and replies the user asks for go to their Confluence site |
| Location | No | The clock's offset from UTC is sent to count credits used per day; it is not a location |
| Web history | Yes | A tab's URL and title, when a question needs them; whether the current tab is a Confluence page, with each question; the URL and title of a tab the user adds to a question; the address of a web page the assistant reads, which goes to the worker, which reads it; and, with "Search with DuckDuckGo" on, the address of DuckDuckGo's results page, which holds the query and which Chrome keeps in the user's browsing history |
| User activity | Yes | Usage events sent to PostHog, unless the user turns them off in the settings: that the panel was opened, a question asked and how it ended, which tools ran, and which of the panel's actions were used. Names from a fixed list, counts, and yes/no values only: no text typed, no page content, title, or URL, no clicks or keystrokes recorded |
| Website content | Yes | The Confluence content the assistant reads (pages, search results, page trees, versions, labels, comments, attachment names); the text of a page on another site it reads (the current tab or a tab the user added, on a site they allowed); text the user selected and sent with "Ask Confluco"; the text of a web page it read by its address; and the queries of web searches it makes, which may hold page content, with their results. All go to the worker and the model, or to OpenRouter when the user answers with their own model; a page read by its address and a search go through the worker either way, unless "Search with DuckDuckGo" is on. A change the user asks for, and a file the user chose to upload after confirming, go to their Confluence site |

All three certifications are checked: no selling or transfer of user data to third parties outside the approved use cases, no use or transfer for purposes unrelated to the single purpose, and none to determine creditworthiness or for lending.

## Privacy policy URL

```text
https://github.com/cofun-labs/cofun/blob/main/extensions/confluco/PRIVACY.md
```
