# UC-NOTICO-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in, formatted the way the AI wrote it: headings, emphasis, lists, tables, code, quotes, and links. The user's own question is shown as typed. Each finished reply can be copied with one press, as the Markdown the AI wrote, to paste elsewhere. A session with no question yet shows Notico's icon and a few suggestions that fit where the user is: the page open in the tab, named by its title; a database, with questions about its entries; or, with no Notion page going with the question (another site, or the open page taken off it), questions about the whole workspace. In Read only, suggestions that would change something are left out. The suggestions are fixed sets chosen from what the message box already knows, so showing them asks neither the AI nor Notion anything. Picking one puts it in the message box, where the user can change it before sending; one that ends in "…" leaves the cursor there, for the user to finish it.

Using Cofun's hosted AI costs credits. How they are charged, and the free credits every user gets each week, are the service's rules, the same in every product: UC-COFUN-CREDITS-001. The hosted model, and who may ask it, are the service's too: UC-COFUN-CHAT-001. A question answered by the user's own model spends none (see UC-NOTICO-AGENT-002). A question the AI answers with tools (see UC-NOTICO-AGENT-001) makes one model call for each round trip, and costs the sum of them.

Key constraints:

- A reply is text the AI wrote, and cannot make the side panel run or load anything: HTML in it is shown as text, images in it are not loaded, and only web links in it can be followed.
- When credits run out partway through a question, the question ends there, like any other failed question (UC-NOTICO-AGENT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then the reply streams back to the extension piece by piece and adds up to the full answer. |
| UC-NOTICO-CHAT-001-S09 | P0 | ✅ | Given a user with no credits left; when they ask the AI; then the request is refused with a message saying when their next free credits arrive, and no model is called. |
| UC-NOTICO-CHAT-001-S11 | P1 | ✅ | Given a question the agent answers with one tool; when the user asks it; then it costs the credits of both model calls. |
| UC-NOTICO-CHAT-001-S12 | P1 | ✅ | Given a user whose credits run out after the agent used a tool; when the agent asks the model again; then the question ends with a message saying when the next free credits arrive, and no model is called. |
| UC-NOTICO-CHAT-001-S03 | P0 | ✅ | Given a signed-in user with the side panel open on Notion; when they send a message; then the message appears and the reply streams in below it. |
| UC-NOTICO-CHAT-001-S08 | P2 | ✅ | Given a session with no question yet; when the user picks a suggestion; then it is in the message box, not sent, and the user can change it before sending; one that ends in "…" leaves the cursor where the "…" was. |
| UC-NOTICO-CHAT-001-S20 | P1 | ✅ | Given a new chat with a Notion page open in Edit; when the panel shows it; then the suggestions name the page by its title and include ones that change it, and neither the AI nor Notion is asked anything. |
| UC-NOTICO-CHAT-001-S21 | P1 | ✅ | Given a new chat with a Notion database open; when the panel shows it; then the suggestions are about its entries, including adding one. |
| UC-NOTICO-CHAT-001-S22 | P1 | ✅ | Given a new chat on a tab that is not a Notion page; when the panel shows it; then the suggestions are about the whole workspace, with a line saying to open a Notion page to work on one. |
| UC-NOTICO-CHAT-001-S23 | P1 | ✅ | Given a new chat in Read only on a page or a database; when the panel shows it; then no suggestion asks for a change. |
| UC-NOTICO-CHAT-001-S24 | P1 | ✅ | Given a new chat on a Notion page; when the user takes the page off the question; then the suggestions are about the whole workspace, and when they add it back, about the page again. |
| UC-NOTICO-CHAT-001-S16 | P1 | ✅ | Given a reply written in Markdown; when it is shown in the side panel; then it reads formatted (headings, emphasis, lists, tables, code, quotes, links), and the user's question is shown as typed. |
| UC-NOTICO-CHAT-001-S17 | P0 | ✅ | Given a reply with HTML and non-web links in it; when it is shown; then the HTML is shown as text, and only its web links can be followed. |
| UC-NOTICO-CHAT-001-S18 | P0 | ✅ | Given a reply with an image in it; when it is shown; then the image is not loaded, and its description links to it instead. |
| UC-NOTICO-CHAT-001-S19 | P1 | ✅ | Given a finished reply; when the user presses its Copy button; then the reply's Markdown is on the clipboard, without its tool calls or what it read and changed, and the button says it was copied. |

### ai-e2e

(none)
