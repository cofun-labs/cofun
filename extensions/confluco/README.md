# Confluco

Confluco is an AI side panel for Chrome. It can answer questions, read the current tab or tabs you add, and search the web. It uses the same Cofun account and credit balance as Notico.

## Connect to self-managed Confluence

Open **Account → Settings → Confluence connection**. Enter the site's base URL, including its deployment path if it has one, and allow access in Chrome. Open a published page on that site and ask about it, or ask Confluco to search published pages. Confluco uses your existing Confluence sign-in in that tab.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

This build starts a new local chat history. Existing Confluco development builds used a different chat store. More Confluence tools are tracked in the [migration](https://github.com/cofun-labs/cofun/issues/540).

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
