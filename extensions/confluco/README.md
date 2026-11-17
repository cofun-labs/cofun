# Confluco

Confluco is an AI side panel for Chrome. It can answer questions, read the current tab or tabs you add, and search the web. It uses the same Cofun account and credit balance as Notico.

## Connect to Confluence

Open **Account → Settings → Confluence connection**. Enter your Cloud site URL (such as `https://team.atlassian.net/wiki`) or your self-managed base URL, including its deployment path if it has one. Allow Chrome site access, then open the connected site and sign in to Confluence. On either site type, you can read the current page, search published content, browse spaces and page trees, and inspect versions, access, labels, discussions and attachments.

In Edit mode on either site type, you can ask to create a published child page, rename a page, add or remove a label, or post a footer comment or reply. For example, ask `Create page "Notes" under this page`.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

On a self-managed site in Edit mode, you can also ask to change page text, for example `Replace "Draft" with "Ready" on this page`. Use **Confluence** in the composer to attach editor text or select a file to upload. A verified edit or move to trash can be undone in the same chat while the page state still matches.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
