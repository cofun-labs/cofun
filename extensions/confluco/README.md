# Confluco

Confluco is an experimental Chrome side panel for self-managed Confluence. It uses your Cofun sign-in and credits for chat and your existing Confluence session for page access.

1. Run `pnpm --filter confluco-extension build` from the repository root and load `extensions/confluco/dist` as an unpacked extension in Chrome.
2. Open Confluco and sign in to Cofun.
3. Choose **Connect Confluence**, enter your instance's base URL with any context path, and grant Chrome access when asked. Sign in to Confluence in the page tab.
4. Open a published page and ask Confluco to read it or search the connected instance. To try an edit, ask `Replace "Old text" with "New text" on this page`. Review the page and exact replacement before choosing **Allow**.

Chats are kept in the open panel. See [Privacy](PRIVACY.md) for what is shared with the hosted model.
