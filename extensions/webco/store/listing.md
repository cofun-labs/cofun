# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Get answers from any web page without leaving it. Webco is an AI copilot in Chrome's side panel that summarizes, explains, and compares what you're reading, across your tabs and the web, and names its sources.

⚡ Nothing to set up: open the panel on any page and ask.
👀 It only reads: Webco changes nothing on any site, and reads a site in your tabs only after you allow it.
🆓 Free credits every week, then pay only for what you use. No subscription.
🔓 Open source, and our server keeps nothing you ask or read.

UNDERSTAND ANY PAGE
• Summarize the article, docs page, or thread you're on, or ask what it says about something.
• Ask about a YouTube video: Webco reads its transcript and points to the moments it cites.
• Long pages are read in parts, so nothing gets cut off.

BRING IN MORE
• Add several open tabs to one question with @ or +, and compare or combine them.
• Paste a link, and Webco reads that page too.
• Search the web, with the sources named.
• Right-click selected text on any page and pick "Ask Webco".

THINGS TO TRY
• "Summarize this page in five bullet points."
• "Compare these two tabs. Which plan fits a team of five?"
• "List this video's key moments with their times."
• "Search the web: is this still the latest version?"

HOW IT WORKS
Webco reads pages in your own tab, so it sees what the page shows you. Sign in once with Google or your email. The panel keeps your chat as you switch tabs, and past chats are saved on your device.

CREDITS
Each question spends credits. Every account gets free credits each week; when you need more, buy a one-time pack in the panel: no subscription, and bought credits last a year. The same account and credits work in Notico and Confluco, Cofun's copilots for Notion and Confluence.
Have your own API key? Bring it through OpenRouter, and the model is paid by your key instead. Web searches and pages rendered for you still spend credits; switch on "Search with DuckDuckGo" to search for free.

PRIVACY
Your questions, and what Webco reads to answer them (pages in your tabs, web pages, and web searches), go to our server and the AI model, or straight to OpenRouter if you use your own model; links and searches go through our server either way, unless DuckDuckGo searches for you. We don't keep that content, only usage numbers and your purchases. Chats are saved only on your device. Webco reports which features are used, never what you write or read, and you can turn that off in the settings. No ads.

AI can make mistakes, so check what matters.

Source code and privacy policy: https://github.com/cofun-labs/cofun
```

## Details

| Field | Value |
|---|---|
| Category | Productivity → Workflow & Planning |
| Language | English |
| Homepage URL | https://cofun.cc/webco |
| Support URL | https://github.com/cofun-labs/cofun/issues |

## Images

| Field | File | Size |
|---|---|---|
| Store icon | [`../public/icons/icon-128.png`](../public/icons/icon-128.png) | 128×128 |
| Screenshots, in this order | [screenshot-1.png](images/screenshot-1.png) (an article in the current tab summarized), [screenshot-2.png](images/screenshot-2.png) (two boards compared, one from a tab added to the question), [screenshot-3.png](images/screenshot-3.png) (a web search on whether the page is still current), [screenshot-4.png](images/screenshot-4.png) (a paragraph sent with "Ask Webco", explained simply) | 1280×800 |
| Small promo tile | [small-promo-tile.png](images/small-promo-tile.png) | 440×280 |
| Marquee promo tile | [marquee-promo-tile.png](images/marquee-promo-tile.png) | 1400×560 |

The screenshots show the real side panel, answering with Cofun's model (Auto), next to public English Wikipedia articles (Honey bee, Raspberry Pi, with Arduino in a tab added to the question), on a test profile where en.wikipedia.org is allowed. They are made with `pnpm e2e --extension webco` and the DevTools protocol: `panel` opens the side panel on the tool's tab, which is then sent to the article; the tab at 920×800 and the side panel at 360×800 are captured separately at twice the pixel density, scaled down, and set side by side, so they carry no browser frame. Ask for short replies, so the question and the whole reply fit in the panel. Chrome's right-click menu can't be captured that way, so screenshot-4 shows what "Ask Webco" does: the paragraph is selected in the page and handed to the panel as the menu's click does (`handOver` in `@cofun/tools/selection` writes it to the window's `chrome.storage.session`). Cofun's avatar in the side panel's header stays; nothing else of the account may show. The promo tiles are laid out in HTML and captured the same way: the small tile is the icon on a white card, the name, "AI copilot for any web page", and one line on what it does, on a teal gradient from `#14a3a5` to `#09686a`; the marquee tile is the same with screenshot-1 scaled into its card (760×475 at 620,62, corners rounded at 14px). Canary captures in a wide-gamut color profile, so every image is converted to sRGB before it is committed (`sips --matchTo '/System/Library/ColorSync/Profiles/sRGB Profile.icc'`); without that, a viewer that ignores the profile shows the colors washed out. The screenshots and promo tiles are PNG without transparency, as the store requires for them.
