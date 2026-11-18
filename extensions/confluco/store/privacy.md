# Chrome Web Store privacy disclosures

Use [the extension privacy policy](../PRIVACY.md) and [Cofun's privacy policy](../../../PRIVACY.md) for the full disclosures.

## Permissions for Confluence

Confluco requests optional access to the site the user connects in Settings. Scripting reads and searches Cloud pages and inspects spaces, page trees, versions, access, labels, discussions and attachment information in the connected tab using its existing Atlassian session. On Cloud it also applies requested page creation, renames, label changes, footer comments and replies, same-space moves and page body copies, recoverable trash, exact text edits, restoration, and undo. Cloud restoration reads and submits the native confirmation form with its anti-forgery value inside the site tab, and a verified reversal is stored with the local chat. On self-managed sites it applies requested changes and reads editor text only when explicitly attached. On either site type, a confirmed local file upload sends the bytes directly to the connected Confluence site. The extension keeps a verified reversal with the local chat when undo is available. Storage keeps the connected base URL per Cofun account and tracks access granted for connections, so unused grants can be released. Confluence credentials remain with their site.

## Data usage

In the Chrome Web Store disclosures, declare website content for page text, titles, source links, and excerpts the user asks the assistant to read. Declare the connected site address and the browsing context used to choose the current tab. The extension keeps this information in the browser as described in its privacy policy and shares the tool result with the model answering that question. It does not sell this data, use it for advertising, or use it for creditworthiness.

Declare personal communications for the user's chat with the assistant. A summary of a long chat is kept with that chat on the device and sent to the selected model when the chat continues. It may include excerpts from pages read during the chat.
