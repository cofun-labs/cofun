# Cofun extension privacy

Cofun opens an AI side panel in Chrome. This page covers the extension. The [shared service privacy policy](../../PRIVACY.md) covers sign-in, the Worker, and credits.

- The page picker reads tab titles and URLs locally. Adding a tab makes its title and URL part of your next question. The assistant can also look up the title and URL of the current tab when you ask about it.
- The assistant can read the current tab or a tab you added once you allowed its site in Chrome. It reads the page already displayed in the tab. This can include content visible to you because you are signed in to the site.
- “Ask Cofun” carries selected text, the page title, and the URL into the composer. The selection stays in the browser until you send the question.
- Public page reads and web search go through the Worker. The Worker receives the URL or the search terms. Results join the conversation.
- Your conversation, including page content used in an answer, goes to the hosted model through the Worker, or to OpenRouter if you use your own key and model.

| Host | Data and purpose |
| --- | --- |
| `api.cofun.cc` | Session token, extension name and version, chat and question IDs, and conversation for hosted chat. Public URLs and search terms for web tools. Time zone offset and pack choice for credits. |
| `clerk.cofun.cc`, `img.clerk.com` | Clerk session and avatar for sign-in and the account display. |
| `openrouter.ai` | If enabled, the OpenRouter key, a request for the model list, and conversations answered by the model you choose. |

Cofun uses a permission for `*.cofun.cc` to detect sign-in changes. Sign-in and Stripe Checkout open in normal browser tabs. Development builds use the hosts you configure.

Your browser profile keeps chats and kept tool results, the session, model settings and OpenRouter key if configured, and your right-click menu preference. Chats and the model key remain in the profile after sign-out. The extension does not send product usage events.
