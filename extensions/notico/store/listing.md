# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Ask Notion anything, right next to your page. Notico is an AI copilot in Chrome's side panel that doesn't just chat: it reads, writes, and organizes your Notion pages and databases for you, and shows you every change it makes.

⚡ Nothing to set up: no integration, no API token. Open the panel and ask.
🆓 Works on any Notion plan, Free included. Free credits every week, then pay only for what you use. No subscription.
🌐 Brings in the web: save an article, a link, or a web search straight to Notion.
🔓 Open source, and our server keeps nothing you ask or read.

WRITE AND EDIT
• Draft pages, add sections, and turn rough notes into action items.
• Select text and ask to rewrite it, shorten it, or change its tone.

WORK WITH DATABASES
• Filter, sort, add rows, and fill in properties.
• Add, rename, or remove properties and options.
• Ask "Which tasks are overdue? Comment on each one." and it's done.

FIND AND ORGANIZE
• Search your workspace and read what it finds, comments included.
• Move or duplicate pages, or move them to the trash (it always asks first).
• Comment on pages and mention teammates.

BRING IN THE WEB
• Ask about the page you're on, a link, or several open tabs at once.
• Search the web, with the sources named.
• Right-click selected text on any page and pick "Ask Notico".
• Notico reads a site in your tabs only after you allow it.

THINGS TO TRY
• "Summarize this page in five bullet points."
• "Turn the notes on this page into action items, with an owner for each."
• "Find our onboarding docs and tell me what's out of date."
• On an article: "Save the key points of this page to my Reading notes."

HOW IT WORKS
Notico works in your own Notion tab, as you: it reaches what you can reach, and nothing else. Sign in once with Google or your email. The panel keeps your chat as you switch tabs, and past chats are saved on your device.

CREDITS
Each question spends credits. Every account gets free credits each week; when you need more, buy a one-time pack in the panel: no subscription, and bought credits last a year.
Have your own API key? Bring it through OpenRouter, and the model is paid by your key instead. Web searches and pages rendered for you still spend credits.

PRIVACY
Your questions, and what Notico reads to answer them (Notion content, web pages, and web searches, which may include text from your Notion pages), go to our server and the AI model, or straight to OpenRouter if you use your own model; links and searches go through our server either way. We don't keep that content, only usage numbers and your purchases. Notico reports which features are used, never what you write or read, and you can turn that off in the settings. No ads.

AI can make mistakes, so check what matters. Every change shows in the panel, and Notion's page history can undo it.

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
| Screenshots, in this order | [screenshot-1.png](images/screenshot-1.png) (action items added to a page), [screenshot-2.png](images/screenshot-2.png) (overdue tasks in a database, with comments), [screenshot-3.png](images/screenshot-3.png) (next week's meeting page made from this one), [screenshot-4.png](images/screenshot-4.png) (selected text rewritten shorter), [screenshot-5.png](images/screenshot-5.png) (an article in an open tab saved to a page) | 1280×800 |
| Small promo tile | [small-promo-tile.png](images/small-promo-tile.png) | 440×280 |
| Marquee promo tile | [marquee-promo-tile.png](images/marquee-promo-tile.png) | 1400×560 |

The screenshots show the real side panel, answering with Cofun's model (Auto), next to throwaway pages, made with `pnpm e2e`: the Notion tab at 920×800 and the side panel at 360×800 are captured separately over the DevTools protocol and set side by side, so they carry no browser frame. Nothing else of the workspace may show: trash earlier throwaway pages first, since the assistant finds them too. Nothing of another product's AI may show either: Notion AI's round button at the bottom right of the Notion tab is painted out (white, over x 850–917 and y 735–799), and Notion's selection toolbar, which offers its AI, is closed before capturing. Screenshot-5's article is a Wikipedia tab added to the question with "+"; the tab itself is not shown. The marquee tile is the same tile with screenshot-1 scaled into its card (760×475 at 620,62, corners rounded at 14px). The screenshots and promo tiles are PNG without transparency, as the store requires for them.
