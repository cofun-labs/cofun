# Confluco

Confluco is an AI side panel for Chrome. It can answer questions, read the current tab or tabs you add, and search the web. It uses the same Cofun account and credit balance as Notico.

## Connect to self-managed Confluence

Open **Account → Settings → Confluence connection**. Enter the site's base URL, including its deployment path if it has one, and allow access in Chrome. Open a page to read or search published content, browse spaces and page trees, and inspect versions, access, labels, discussions, and attachments. Confluco uses your existing Confluence sign-in in that tab.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

In Edit mode, ask for a specific change, for example `Create page "Notes" under this page` or `Replace "Draft" with "Ready" on this page`. Use **Confluence** in the composer to attach editor text or select a file to upload. A verified edit or move to trash can be undone in the same chat while the page state still matches. Existing standalone Confluco chats and undo records stay in their original extension.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
