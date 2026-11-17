# Confluco

Confluco is an AI side panel for Chrome. It can answer questions, read the current tab or tabs you add, and search the web. It uses the same Cofun account and credit balance as Notico.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

This build starts a new local chat history. Existing Confluco development builds used a different chat store. Confluence workspace tools are part of the [migration](https://github.com/cofun-labs/cofun/issues/540).

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
