# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Ask Notion anything, right next to the page. Notico is an AI copilot that reads, writes, and organizes your Notion pages from Chrome's side panel, and shows you every change it makes.

✓ Free to start: every account gets free credits each week
✓ Nothing to set up in Notion: no integration, no API token
✓ Or answer with your own model on OpenRouter, with your own key
✓ Open source (Apache 2.0)

WHAT YOU CAN ASK
• Summarize and explain: the page you have open or any other page, long pages included, with their comments.
• Write and rewrite: draft new pages, add sections, rewrite or shorten what you selected, fix titles and icons.
• Work with databases: read them as tables, filter and sort, add rows, fill in properties, and add, rename, or remove properties and select options.
• Find things: search your workspace, or browse pages the way the sidebar lists them, then read what it finds.
• Organize: move pages under another page, duplicate them, or move them to Notion's trash (it always asks you first).
• Collaborate: comment on a page or a block, and mention workspace members by name.

THINGS TO TRY
• "Summarize this page in five bullet points."
• "Turn the notes on this page into a list of action items, with an owner for each."
• "Which tasks in this database are overdue? Add a comment on each one."
• "Find our onboarding docs and tell me what's out of date."
• Select some text, then: "Rewrite this to be shorter."

STAYS IN CONTEXT
Notico knows which page is open and what you selected. The panel stays open, with your chat, as you switch tabs, and past chats are saved on your device so you can pick them up again.

HOW IT WORKS
Notico works inside your own Notion tab, with the session you're already signed in with, so it can reach what you can reach and nothing else. Sign in to Notico once with Google or your email; nothing else to configure.

CREDITS
Asking Cofun's AI model costs credits. Every account gets free credits each week, and the panel shows how many you have left and when they renew. When you need more, buy a pack in the panel: it opens Stripe's checkout, nothing renews, and bought credits last a year. Answering with your own model on OpenRouter spends no credits, except on web pages rendered in a browser and web searches made for a question.

PRIVACY
Your questions, and the Notion content Notico reads to answer them, go to our server and on to an AI model running on Cloudflare Workers AI, or, if you set up your own model, straight to OpenRouter with your key. The server does not store that content: it keeps only usage numbers and your purchases, never the text of a question or an answer. Chats are saved only in Chrome on your device. Notico also reports which features are used and whether they worked, never the text of a question, an answer, or a page; you can turn that off in the settings. No ads.

PLEASE NOTE
• Notico edits pages as soon as it decides to; moving pages to the trash is the one thing it asks about first. Every change is shown in the side panel, and Notion's page history can undo edits. Switch the message box to Read only to keep it from changing anything.
• Be careful with pages written by others: text in them could steer the assistant.

Source code and privacy policy: https://github.com/cofun-labs/cofun

Notico is an independent project. It is not made or endorsed by Notion.
```

## Details

| Field | Value |
|---|---|
| Category | Productivity → Workflow & Planning |
| Language | English |
| Homepage URL | https://cofun.cc |
| Support URL | https://github.com/cofun-labs/cofun/issues |

## Images

| Field | File | Size |
|---|---|---|
| Store icon | [`../public/icons/icon-128.png`](../public/icons/icon-128.png) | 128×128 |
| Screenshots, in this order | [screenshot-1.png](images/screenshot-1.png) (action items added to a page), [screenshot-2.png](images/screenshot-2.png) (overdue tasks in a database, with comments), [screenshot-3.png](images/screenshot-3.png) (next week's meeting page made from this one), [screenshot-4.png](images/screenshot-4.png) (selected text rewritten shorter) | 1280×800 |
| Small promo tile | [small-promo-tile.png](images/small-promo-tile.png) | 440×280 |
| Marquee promo tile | [marquee-promo-tile.png](images/marquee-promo-tile.png) | 1400×560 |

The screenshots show the real side panel, answering with Cofun's model (Auto), next to throwaway pages, made with `pnpm e2e`: the Notion tab at 920×800 and the side panel at 360×800 are captured separately over the DevTools protocol and set side by side, so they carry no browser frame. Nothing else of the workspace may show: trash earlier throwaway pages first, since the assistant finds them too. Nothing of another product's AI may show either: Notion AI's round button at the bottom right of the Notion tab is painted out (white, over x 850–917 and y 735–799), and Notion's selection toolbar, which offers its AI, is closed before capturing. The marquee tile is the same tile with screenshot-1 scaled into its card (760×475 at 620,62, corners rounded at 14px). The screenshots and promo tiles are PNG without transparency, as the store requires for them.

## For the next version

The text above describes version 0.2.0. The version after it also reads the page the user is on when it is another site, so the description says Notico works around Notion, not only inside it:

- The first paragraph reads: "Ask Notion anything, right next to the page. Notico is an AI copilot that reads, writes, and organizes your Notion pages from Chrome's side panel, and shows you every change it makes. It can also read the page you're on elsewhere, so you can ask about an article or save it to Notion."
- WHAT YOU CAN ASK adds: "• Bring in the web: ask about the page you're on, or save it to Notion. Notico reads a site only after you allow it."
- THINGS TO TRY adds: "• On an article: "Save the key points of this page to my Reading notes.""
- PRIVACY reads "Your questions, and what Notico reads to answer them (Notion content, and a web page you asked about), go to our server…".
