# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Ask Confluence anything, right next to the page. Confluco is an AI copilot in Chrome's side panel that reads your Confluence pages, finds what's out of date, and updates them when you ask.

⚡ Nothing to set up: no API token, no app to install in Confluence. It uses the session you're already signed in with.
☁️ Works on Confluence Cloud and on self-managed Confluence.
🆓 Free credits every week, then pay only for what you use. No subscription.
🔓 Open source, and our server keeps nothing you ask or read.

READ AND UNDERSTAND
• Summarize the page you're on, or ask what was decided and who owns what.
• Search published content, and browse spaces and page trees.
• Look into versions, labels, comments, and attachments.

KEEP PAGES UP TO DATE
• Compare pages and spot what's out of date.
• Replace exact text, rename pages, add labels, and post comments and replies.
• Create child pages, move or copy pages, and move a page to the trash after you confirm.
• Undo the last edit from the chat.

BRING IN THE WEB
• Ask about any open tab, add several tabs to one question, or search the web.
• Right-click selected text on any page and pick "Ask Confluco".
• Confluco reads a site in your tabs only after you allow it.

THINGS TO TRY
• "What did we decide, and who owns what?"
• "Compare this launch plan with the tab I added. Is the launch date still right?"
• Replace "Nov 20" with "Nov 27" on this page.

CREDITS
Each question spends credits. Every account gets free credits each week; when you need more, buy a one-time pack in the panel: no subscription, and bought credits last a year. The same account and credits work in Notico, Cofun's copilot for Notion.
Have your own API key? Bring it through OpenRouter, and the model is paid by your key instead. Web searches and pages rendered for you still spend credits; switch on "Search with DuckDuckGo" to search for free.

PRIVACY
Your questions, and what Confluco reads to answer them (Confluence content, web pages, and web searches), go to our server and the AI model, or straight to OpenRouter if you use your own model; links and searches go through our server either way, unless DuckDuckGo searches for you. Requests to Confluence run in your own tab, with your session. We don't keep that content, only usage numbers and your purchases. Chats are saved only on your device. Confluco reports which features are used, never what you write or read, and you can turn that off in the settings. No ads.

Confluco changes a page only when you ask for that change in so many words, and every change shows in the panel. AI can make mistakes, so check what matters.

Source code and privacy policy: https://github.com/cofun-labs/cofun

Confluco is an independent project, not made or endorsed by Atlassian.
```

## Details

| Field | Value |
|---|---|
| Category | Productivity → Workflow & Planning |
| Language | English |
| Homepage URL | https://cofun.cc |
| Support URL | https://github.com/cofun-labs/cofun/issues |
| Global promo video | Not set yet: the demo video is uploaded to YouTube by hand, and its link goes here |

## Images

| Field | File | Size |
|---|---|---|
| Store icon | [`../public/icons/icon-128.png`](../public/icons/icon-128.png) | 128×128 |
| Screenshots, in this order | [screenshot-1.png](images/screenshot-1.png) (decisions and owners from a meeting page), [screenshot-2.png](images/screenshot-2.png) (a launch plan found out of date against another tab), [screenshot-3.png](images/screenshot-3.png) (the launch date replaced on the page), [screenshot-4.png](images/screenshot-4.png) (a paragraph sent with "Ask Confluco", rewritten shorter) | 1280×800 |
| Small promo tile | [small-promo-tile.png](images/small-promo-tile.png) | 440×280 |
| Marquee promo tile | [marquee-promo-tile.png](images/marquee-promo-tile.png) | 1400×560 |

The screenshots show the real side panel, answering with Cofun's model (Auto), next to throwaway pages in a personal space of a test Confluence Cloud site. They are made with `pnpm e2e --extension confluco` and the DevTools protocol: the Confluence tab at 920×1000 and the side panel at 360×1000 are captured separately at twice the pixel density, the top 800 of the tab is kept, the panel keeps its messages and its message box (the empty space between them is cut), and both are scaled down and set side by side, so they carry no browser frame. Chrome's right-click menu can't be captured that way, so screenshot-4 shows what "Ask Confluco" does: the paragraph is selected in the page and handed to the panel as the menu's click does (`handOver` in `@cofun/tools/selection` writes it to the window's `chrome.storage.session`). Its chip under the question names the site's address before the quote: that address is painted out and the quote written again in its place. Confluence's account avatars (in the site's top bar and by the page's status) and the page's byline are painted white; Cofun's avatar in the side panel's header stays, and the space's name may show in tab titles. Nothing else of the site may show: move the throwaway pages to the trash afterwards. The marquee tile is the small tile's layout with screenshot-1 scaled into its card (760×475 at 620,62, corners rounded at 14px). The screenshots and promo tiles are PNG without transparency, as the store requires for them.
