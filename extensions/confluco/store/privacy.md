# Chrome Web Store privacy disclosures

Use [the extension privacy policy](../PRIVACY.md) and [Cofun's privacy policy](../../../PRIVACY.md) for the full disclosures.

## Permissions for Confluence

Confluco requests optional access to a Confluence site when the user allows it, from the card of a request on a page of that site. Scripting reads and searches Cloud pages and inspects spaces, page trees, versions, access, labels, discussions and attachment information in the connected tab using its existing Atlassian session. On Cloud it also applies requested page creation, renames, label changes, footer comments and replies, same-space moves and page body copies, recoverable trash, exact text edits, restoration, and undo. Cloud restoration reads and submits the native confirmation form with its anti-forgery value inside the site tab, and a verified reversal is stored with the local chat. On self-managed sites it applies requested changes and reads editor text only when explicitly attached. On either site type, a confirmed local file upload sends the bytes directly to the connected Confluence site. The extension keeps a verified reversal with the local chat when undo is available. Confluence credentials remain with their site.

## Permissions for DuckDuckGo

html.duckduckgo.com, an optional host permission, only when the user switches on "Search with DuckDuckGo" in Settings, which asks Chrome for it. Each web search then opens DuckDuckGo's results page in a background tab, and scripting reads the results in that tab, which the extension then closes, free, instead of searching through our server. When DuckDuckGo asks to confirm a person is searching, the tab stays open for the user and the extension never answers the check. Storage keeps whether the setting is on, per Cofun account.

## Data usage

In the Chrome Web Store disclosures, declare website content for page text, titles, source links, and excerpts the user asks the assistant to read. Declare the Confluence site address and the browsing context used to choose the current tab. With "Search with DuckDuckGo" on, declare the queries of web searches, which may hold website content, as the address of DuckDuckGo's results page the browser opens in a tab (Chrome keeps it in the user's browsing history), and the results read from it. The extension keeps this information in the browser as described in its privacy policy and shares the tool result with the model answering that question. It does not sell this data, use it for advertising, or use it for creditworthiness.

Declare personal communications for the user's chat with the assistant. A summary of a long chat is kept with that chat on the device and sent to the selected model when the chat continues. It may include excerpts from pages read during the chat.
