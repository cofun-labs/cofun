# UC-NOTICO-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in, formatted the way the AI wrote it, and can copy a finished reply as its Markdown. A chat with no question yet offers a few suggestions that fit the open page or database, or the whole workspace, or on another site the page in the tab and the web, without asking the AI or Notion anything.

Using Cofun's hosted AI costs credits, one model call for each round trip of a question. How credits are charged, and who may ask the hosted model, are the service's rules: UC-COFUN-CREDITS-001 and UC-COFUN-CHAT-001. A question answered by the user's own model spends none on the model (UC-NOTICO-AGENT-002).

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
| UC-NOTICO-CHAT-001-S20 | P1 | ✅ | Given a new chat; when the panel shows it; then its suggestions fit what the question goes with: a page by its title, with ones that change it in Edit and none in Read only; a database, about its entries; with the page taken off, the whole workspace, and back to the page's suggestions once it is added again; or, on another site, reading the page in the tab (on a YouTube video, summarizing it and listing its moments with their times) and searching the web (only searching, when Notico can't read the tab), with a note that the workspace needs a Notion page in the tab, and how to save the page, or notes on the video, to Notion; and neither the AI nor Notion is asked anything. |
| UC-NOTICO-CHAT-001-S16 | P1 | ✅ | Given a reply written in Markdown; when it is shown in the side panel; then it reads formatted (headings, emphasis, lists, tables, code, quotes, links), the user's question is shown as typed, and the reply's Copy button puts its Markdown on the clipboard, without its tool calls or what it read and changed. |

### ai-e2e

(none)
