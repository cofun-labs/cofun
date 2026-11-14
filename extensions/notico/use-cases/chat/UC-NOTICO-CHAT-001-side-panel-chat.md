# UC-NOTICO-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in, formatted the way the AI wrote it: headings, emphasis, lists, tables, code, quotes, and links. The user's own question is shown as typed. Each finished reply can be copied with one press, as the Markdown the AI wrote, to paste elsewhere. A session with no question yet offers a few example questions; picking one puts it in the message box, where the user can change it before sending.

Using Notico's hosted AI costs credits, so one account cannot run up unbounded model usage. A question answered by the user's own model spends none (see UC-NOTICO-AGENT-002). A credit is a thousandth of a US dollar, and each call to the model costs what its tokens cost the service, with nothing added. Input the model reads from its cache costs less than new input, and is charged at that lower price. A question the AI answers with tools (see UC-NOTICO-AGENT-001) makes one model call for each round trip, and costs the sum of them.

Every signed-in user gets 200 free credits a week. They arrive when the user asks and has no current week of credits, and they expire 7 days later; a new week starts the next time the user asks after that, so unused credits never add up.

Key constraints:

- The server chooses the hosted model. Clients cannot make it use another one.
- A reply is text the AI wrote, and cannot make the side panel run or load anything: HTML in it is shown as text, images in it are not loaded, and only web links in it can be followed.
- A user with no credits left cannot reach the model again until they get more credits: their next free credits, or credits they buy (UC-NOTICO-BILLING-001).
- A model call that starts with credits left is answered in full, even when it costs more than what was left. What it overspent is taken out of the next credits the user gets.
- Credits that have expired cannot be spent.
- When credits run out partway through a question, the question ends there, like any other failed question (UC-NOTICO-AGENT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then the reply streams back to the extension piece by piece and adds up to the full answer. |
| UC-NOTICO-CHAT-001-S02 | P1 | ✅ | Given a signed-in user; when a client asks for a model other than the server's; then the request is refused and no model is called. |
| UC-NOTICO-CHAT-001-S09 | P0 | ✅ | Given a user with no credits left; when they ask the AI; then the request is refused with a message saying when their next free credits arrive, and no model is called. |
| UC-NOTICO-CHAT-001-S10 | P1 | ✅ | Given a user who ran out of credits; when they ask the AI after their week of credits has ended; then they have a new week of free credits and get a reply. |
| UC-NOTICO-CHAT-001-S11 | P1 | ✅ | Given a question the agent answers with one tool; when the user asks it; then it costs the credits of both model calls. |
| UC-NOTICO-CHAT-001-S12 | P1 | ✅ | Given a user whose credits run out after the agent used a tool; when the agent asks the model again; then the question ends with a message saying when the next free credits arrive, and no model is called. |
| UC-NOTICO-CHAT-001-S13 | P1 | ✅ | Given a user whose last model call cost more than the credits they had left; when their next free credits arrive; then what they overspent is taken out of those credits first. |
| UC-NOTICO-CHAT-001-S14 | P1 | ✅ | Given a user with credits left when their week ends; when they ask the AI afterwards; then the leftover is gone and only the new week's credits can be spent. |
| UC-NOTICO-CHAT-001-S15 | P1 | ✅ | Given a model call whose input was partly read from the model's cache; when it is charged; then the cached part costs the cached price and the rest the full price. |
| UC-NOTICO-CHAT-001-S03 | P0 | ✅ | Given a signed-in user with the side panel open on Notion; when they send a message; then the message appears and the reply streams in below it. |
| UC-NOTICO-CHAT-001-S08 | P2 | ✅ | Given a session with no question yet; when the user picks one of the example questions; then it is in the message box, not sent, and the user can change it before sending. |
| UC-NOTICO-CHAT-001-S16 | P1 | ✅ | Given a reply written in Markdown; when it is shown in the side panel; then it reads formatted (headings, emphasis, lists, tables, code, quotes, links), and the user's question is shown as typed. |
| UC-NOTICO-CHAT-001-S17 | P0 | ✅ | Given a reply with HTML and non-web links in it; when it is shown; then the HTML is shown as text, and only its web links can be followed. |
| UC-NOTICO-CHAT-001-S18 | P0 | ✅ | Given a reply with an image in it; when it is shown; then the image is not loaded, and its description links to it instead. |
| UC-NOTICO-CHAT-001-S19 | P1 | ✅ | Given a finished reply; when the user presses its Copy button; then the reply's Markdown is on the clipboard, without its tool calls or the line under it, and the button says it was copied. |

### ai-e2e

(none)
