# Privacy

The Dashboard's Privacy tab. It must agree with [Notico's privacy page](../PRIVACY.md) and [Cofun's](../../../PRIVACY.md), which together are the privacy policy it links to.

## Single purpose

```text
Notico is an AI assistant in Chrome's side panel that reads and edits the user's Notion pages at the user's request.
```

## Permission justifications

One for each permission in the manifest, and one for its host permissions together.

### sidePanel

```text
The extension's whole interface is a side panel, where the user chats with the assistant next to their Notion page.
```

### storage

```text
Keeps the user signed in (the sign-in client token); the user's own OpenRouter key, if they set one up, with the models they switched on and the model chosen in the message box; and small settings: whether the assistant may change the user's pages (Edit or Read only), and whether usage data is shared.
```

### tabs

```text
Reads the current tab's URL and title to tell whether it is a Notion page, and to find the Notion tab the assistant works in. A non-Notion tab's URL and title are sent only when the user's question needs them. When the user opens the page picker in the message box, it also reads the URLs and titles of the other tabs that show Notion pages, to offer them; one is sent only when the user adds it to a question.
```

### cookies

```text
Reads the sign-in cookies that our own sign-in service (Clerk, on cofun.cc) sets, to bring the user's session into the extension and to notice sign-in and sign-out. It reads no cookies of other sites.
```

### scripting

```text
Runs the requests that read and edit Notion pages inside the user's own Notion tab, with that tab's session, so no Notion credentials leave the tab.
```

### Host permission

```text
www.notion.so and app.notion.com: to read and edit the user's pages in their Notion tab. api.cofun.cc: our server and sign-in page. clerk.cofun.cc: our sign-in service, whose session cookie the extension reads to sign the user in. *.cofun.cc: only to read the sign-in cookie that the sign-in service sets on the parent domain.
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
| Personal communications | Yes | The user's conversation with the assistant goes to the worker and the model, or to OpenRouter when the user answers with their own model, and to the user's own Notion workspace when the user saves a chat or a reply there |
| Location | No | The clock's offset from UTC is sent to count credits used per day; it is not a location |
| Web history | Yes | A tab's URL and title, when a question needs them, and the URL and title of a Notion page open in another tab that the user adds to a question |
| User activity | Yes | Usage events sent to PostHog, unless the user turns them off in the settings: that the panel was opened, a question asked and how it ended, which tools ran, and which of the panel's actions were used. Names from a fixed list, counts, and yes/no values only: no text typed, no page content, title, or URL, no clicks or keystrokes recorded |
| Website content | Yes | The Notion content the assistant reads goes to the worker and the model, or to OpenRouter when the user answers with their own model |

All three certifications are checked: no selling or transfer of user data to third parties outside the approved use cases, no use or transfer for purposes unrelated to the single purpose, and none to determine creditworthiness or for lending.

## For the next version

This page describes version 0.2.0. The version after it adds optional host permissions for web sites, which the user grants one site at a time (none at install), and reads web pages whose address the user gives (through the worker, with no new permission), so before it is submitted:

- The **single purpose** reads: "Notico is an AI assistant in Chrome's side panel that reads and edits the user's Notion pages at the user's request, and reads the page the user is on, on a site they allowed, or a web page whose address they give, when a question is about it."
- The **scripting** justification adds: "On another site, and only on one the user allowed, it reads the text of the page in the current tab, inside that tab, when the user's question is about that page."
- The **Host permission** justification adds: "Optional host permissions for http and https sites: none is granted at install. When the user asks about the page they are on, the side panel asks them to allow that one site, and Chrome asks them again; only then is the page's text read, in the tab."
- **Website content** also names the text of a page on another site that the assistant reads, and of a web page whose address the user gave, which goes to the worker and the model (or to OpenRouter; a page read by its address is read through the worker either way). **Web history** stays Yes, as it is: that page's URL and title go with it, and the address of a web page the user gave goes to the worker, which reads it.

## Privacy policy URL

```text
https://github.com/cofun-labs/cofun/blob/main/extensions/notico/PRIVACY.md
```
