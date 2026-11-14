# UC-NOTICO-SESSION-002: Save a chat or a reply to Notion

## Behavior

A signed-in user keeps what the AI answered in Notion itself, without asking the AI to write it: from a reply's "…" menu, they save that reply, or the whole chat so far. Either way the result is a new page at the end of the Notion page open in the current tab at that moment; to save somewhere else, the user opens that page first. Saving to a database is not supported.

A whole chat is titled with the chat's title; a single reply with the chat's title followed by the question it answers, cut to a sensible length. The page holds each question and its reply as formatted text, without the details of the tools the AI ran: a reply that read or changed pages ends with one line saying how many, linking the pages it changed. A person a reply names is written as their name, and nobody is mentioned or notified.

The page is created as soon as the user saves, with no step to confirm, and a link to it shows where the action was. Saving is the user's own action, so it works in Read only too (UC-NOTICO-AGENT-003): Read only limits only what the AI may change.

Key constraint:

- A save never creates two pages: it is not retried. When Notion turns it away, nothing more is sent and the user is told to wait; when Notion does not say whether the page was made, the user is told to check in Notion before saving again.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-002-S01 | P0 | ✅ | Given a reply that read and changed pages, with a Notion page open; when the user saves the reply to Notion; then a new page is created at the end of the open page, titled with the chat's title and the question, holding the question and the reply's formatted text without tool details, ending with a line of what it read and changed that links the changed page, and a link to the new page shows in the reply's menu. |
| UC-NOTICO-SESSION-002-S02 | P0 | ✅ | Given an open chat of two questions, with a Notion page open; when the user saves the chat from the first reply's menu; then a new page titled with the chat's title is created at the end of the open page, holding both questions and replies in order, and a link to it shows in that menu. |
| UC-NOTICO-SESSION-002-S03 | P1 | ✅ | Given the current tab is not a Notion page; when the user opens a reply's menu; then saving the reply and saving the chat are unavailable and say to open a Notion page first, and nothing is sent to Notion. |
| UC-NOTICO-SESSION-002-S04 | P1 | ✅ | Given the open page is a database; when the user saves a reply; then nothing is created, and the user is told saving into a database isn't supported and to open a page. |
| UC-NOTICO-SESSION-002-S05 | P1 | ✅ | Given the user switched to Read only; when they save a reply; then the page is created as in Edit. |
| UC-NOTICO-SESSION-002-S06 | P1 | ✅ | Given Notion turns the save away; when the user saves a reply; then nothing more is sent to Notion, and the user is told to wait before trying again. |
| UC-NOTICO-SESSION-002-S07 | P1 | ✅ | Given Notion does not answer whether the page was created; when the user saves a reply; then the save is not retried, and the user is told to check in Notion before saving again. |
| UC-NOTICO-SESSION-002-S08 | P1 | ✅ | Given a reply that names a person as a mention; when the user saves it; then the page shows the name as text and mentions nobody. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-002-S09 | P1 | ✅ | Given the side panel open on a Notion page with a reply that has headings and a list; when the user saves the reply to Notion and opens the link; then the new page sits under the open page with the question and the reply formatted as in the side panel. |
