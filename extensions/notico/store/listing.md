# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Ask Notion anything, right next to the page. Notico is an AI copilot in Chrome's side panel that reads, writes, and organizes your Notion pages, and shows you every change it makes. It also brings in the web: ask about the page you're on, a link, or a web search, and save what matters to Notion.

✓ Free to start: free credits every week
✓ Nothing to set up: no Notion integration, no API token
✓ Or bring your own model through OpenRouter
✓ Open source

WHAT YOU CAN ASK
• Summarize and explain the page you're on, or any other, comments included.
• Draft pages, add sections, and rewrite what you selected.
• Work with databases: filter, sort, add rows, and fill in properties.
• Find pages across your workspace and read them.
• Move, duplicate, or trash pages (it asks before trashing).
• Comment on pages and mention teammates.
• Bring in the web: ask about the page you're on or a link, compare open tabs, or search the web. Notico reads a site in your tabs only after you allow it.
• Right-click selected text on any page and pick "Ask Notico".

THINGS TO TRY
• "Summarize this page in five bullet points."
• "Turn the notes on this page into action items, with an owner for each."
• "Which tasks in this database are overdue? Add a comment on each one."
• "Find our onboarding docs and tell me what's out of date."
• Select some text, then: "Rewrite this to be shorter."
• On an article: "Save the key points of this page to my Reading notes."

HOW IT WORKS
Notico works in your own Notion tab, as you, so it reaches what you can reach and nothing else. Sign in once with Google or your email. Your chat stays open as you switch tabs, and past chats are saved on your device.

CREDITS
Cofun's AI model runs on credits. Every account gets free credits each week, and you can buy more in the panel: one-time packs, no subscription, valid for a year. Answering with your own model spends no credits, except on web searches and pages rendered for you.

PRIVACY
Your questions, and what Notico reads to answer them (Notion content, web pages, and web searches, which may include text from your Notion pages), go to our server and the AI model, or straight to OpenRouter if you use your own model; links and searches go through our server either way. We don't keep that content, only usage numbers and your purchases. Chats are saved only on your device. Notico reports which features are used, never what you write or read, and you can turn that off in the settings. No ads.

PLEASE NOTE
• Notico edits as soon as it decides to; only trashing asks first. Every change shows in the panel, and Notion's page history can undo it. Switch to Read only to keep it from changing anything.
• Text in pages written by others could steer the assistant, so take care with them.

Source code and privacy policy: https://github.com/cofun-labs/cofun

Notico is an independent project, not made or endorsed by Notion.
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
