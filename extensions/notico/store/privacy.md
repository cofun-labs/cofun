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
Keeps the user signed in (the sign-in client token) and a small setting: how long to wait after Notion asked it to slow down.
```

### tabs

```text
Reads the current tab's URL and title to tell whether it is a Notion page, and to find the Notion tab the assistant works in. A non-Notion tab's URL and title are sent only when the user's question needs them.
```

### cookies

```text
Reads the sign-in cookie set by our own sign-in page (on cofun.cc) to notice when the user signs in or out. It reads no other cookies.
```

### scripting

```text
Runs the requests that read and edit Notion pages inside the user's own Notion tab, with that tab's session, so no Notion credentials leave the tab.
```

### Host permission

```text
notion.so and app.notion.com: to read and edit the user's pages in their Notion tab. api.cofun.cc and clerk.cofun.cc: our server and sign-in service. *.cofun.cc: only to read the sign-in cookie, which the sign-in service sets on the parent domain.
```

## Remote code

No, I am not using remote code. Everything the extension runs is in its package; its content security policy allows scripts only from the extension itself (`script-src 'self'`).

## Data usage

| Category | Collected | Why |
|---|---|---|
| Personally identifiable information | Yes | The account's name, email address, and avatar, shown in the panel |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | Yes | The Clerk session token and cookie |
| Personal communications | Yes | The user's conversation with the assistant goes to the worker and the model |
| Location | No | The clock's offset from UTC is sent for the credit history; it is not a location |
| Web history | Yes | A tab's URL and title, when a question needs them |
| User activity | No | |
| Website content | Yes | The Notion content the assistant reads goes to the worker and the model |

All three certifications are checked: no selling or transfer of user data to third parties outside the approved use cases, no use or transfer for purposes unrelated to the single purpose, and none to determine creditworthiness or for lending.

## For the next version

This page describes version 0.1.0, the one in the store. The version after it lets users answer with their own OpenRouter or DeepSeek key, so before it is submitted:

- The **storage** justification also says that the user's own model keys, and the model chosen with each, are kept there.
- The data usage stays as it is: a user's own key is authentication information, and the conversation and the Notion content it holds go to the model service the user chose, which is personal communications and website content again. The privacy policy already says so.
- The extension asks for no new permission: OpenRouter and DeepSeek are reached under the content security policy, not through host permissions.

## Privacy policy URL

```text
https://github.com/cofun-labs/cofun/blob/main/extensions/notico/PRIVACY.md
```
