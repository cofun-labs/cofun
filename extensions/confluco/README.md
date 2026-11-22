# Confluco

Confluco is an AI side panel for Chrome that works with Confluence: ask about the page you're on, search your site, and update pages when you ask. It can also read the current tab or tabs you add on other sites, a YouTube video's transcript included, and search the web. It uses the same Cofun account and credit balance as Notico.

The model can summarize earlier messages to continue a long chat. You can still read the original messages when you reopen it. OpenRouter models need a context window of at least 200,000 tokens.

Web searches and pages rendered in a browser cost credits, also when your own model answers. To search for free instead, switch on **Search with DuckDuckGo** in **Account → Settings**: each search then opens DuckDuckGo in a background tab and reads its results. Those searches show in your Chrome history, and if DuckDuckGo asks you to confirm you're a person, answer it in that tab.

## Use it on Confluence

Open a page on your Confluence site, signed in as usual, and ask. The first time Confluco needs the site, it asks you to allow it, and Chrome asks too. This works on Confluence Cloud (`https://team.atlassian.net/wiki`) and on self-managed Confluence. On either site type, you can read the current page, search published content, browse spaces and page trees, and inspect versions, access, labels, discussions and attachments.

In Edit mode, ask for what you want done, and Confluco works out the changes: it can create published child pages, rename pages, change text on a page, add or remove labels, post footer comments and replies, move pages or copy a page's body within a space, and move a page to the trash. For example, ask to tidy this page's meeting notes, or to move last year's meeting notes under Archive. On Cloud, publishing an edit can merge into or overwrite an unpublished draft.

> [!WARNING]
> **It edits without asking first.** Confluco makes its changes as soon as it decides to. Moving a page to the trash is the one thing it asks you about, every time. Each change is shown in the side panel as it happens. Confluco has no undo: in Confluence, restore an earlier version from the page history, or a page from the space's trash. To keep it from changing anything, switch the message box to **Read only** with the pencil button at its bottom left.

> [!CAUTION]
> **Be careful with pages you don't control.** A team wiki holds text written by other people, and Confluco reads it: pages, comments, search results, and web pages you ask about. An instruction hidden in that text could make it act as you without anyone being asked, for example by changing a colleague's page, or copying something private into a page or a comment that others can read. Comments also notify people. Page history can undo a change, but not what someone read in the meantime. [More on this trade-off](../../docs/security.md#accepted-writes-without-approval).

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
