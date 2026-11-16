# Confluco privacy

This page covers the Chrome extension. [Cofun privacy](../../PRIVACY.md) covers shared sign-in, the Worker, and credits.

## What Confluco accesses

- The active Chrome tab's URL and title identify a page of your connected self-managed Confluence instance. Its context may be sent with your question to the hosted model.
- Page text, titles, links, and search results requested by the agent are sent to the hosted model as part of the conversation. The extension sends the text of your question and the agent's conversation to the Cofun Worker.
- Confluco makes the site requests within the connected tab using your Confluence session. A confirmed edit sends the updated page body and next version only to Confluence. Confluence session credentials are handled by the browser in the site tab.
- The panel stores the configured instance URL in Chrome's local extension storage, keyed by Cofun account. Chat content is held in memory while the panel is open.

## Where data goes

| Host                                                 | Purpose                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `api.cofun.cc`                                       | Cofun sign-in, hosted chat, credits, and Stripe Checkout setup |
| `clerk.cofun.cc`                                     | Cofun identity and session sync                                |
| `img.clerk.com`                                      | Account avatars and provider icons                             |
| The self-managed Confluence site you grant access to | Page reads, searches, and confirmed edits made from its tab    |

If you buy credits, Confluco opens Stripe's hosted Checkout in a browser tab. See [Cofun privacy](../../PRIVACY.md) for billing.
