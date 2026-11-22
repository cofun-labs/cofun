# Confluco

Confluco is an AI side panel for Chrome that works with Confluence: ask about the page you're on, search your site, and update pages when you ask. It can also read the current tab or tabs you add on other sites, a YouTube video's transcript included, and search the web. It uses the same Cofun account and credit balance as Notico.

The model can summarize earlier messages to continue a long chat. You can still read the original messages when you reopen it. OpenRouter models need a context window of at least 200,000 tokens.

Web searches and pages rendered in a browser cost credits, also when your own model answers. To search for free instead, switch on **Search with DuckDuckGo** in **Account → Settings**: each search then opens DuckDuckGo in a background tab and reads its results. Those searches show in your Chrome history, and if DuckDuckGo asks you to confirm you're a person, answer it in that tab.

## Use it on Confluence

Open a page on your Confluence site, signed in as usual, and ask. The first time Confluco needs the site, it asks you to allow it, and Chrome asks too. This works on Confluence Cloud (`https://team.atlassian.net/wiki`) and on self-managed Confluence. On either site type, you can read the current page, search published content, browse spaces and page trees, and inspect versions, access, labels, discussions and attachments.

In Edit mode on either site type, you can ask to create a published child page, rename a page, add or remove a label, or post a footer comment or reply. For example, ask `Create page "Notes" under this page`. You can also move a page or copy its body within the space and confirm moving an eligible page to the trash. You can also replace exact published text and restore a page by its link with space administrator access. On Cloud, publishing an edit can merge into or overwrite an unpublished draft. To undo a change, use Confluence: restore an earlier version from the page history, or a page from the space trash.

Use **Confluence** in the composer to select a file and confirm an upload or replacement on the current published page. On Cloud, Confluence matches attachments by filename. A concurrent same-name upload can receive the selected file as a new version. On a self-managed site you can also use **Attach editor selection**.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
