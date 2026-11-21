# UC-NOTICO-CHAT-006: Ask about text selected on a page

## Behavior

Text a user sends with "Ask Notico" from the right-click menu waits in the message box until a question carries it. Selections add up, across tabs and chats, until a question carries them or the user takes them off, and a question shows the selections it carried, also once its chat is reopened.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-006-S03 | P1 | ✅ | Given two selections sent before the side panel opened; when the user sends two more, takes two off with their buttons, and asks; then the question carries the others in the order sent; and Backspace in an empty message takes the selections off, the last first. |
| UC-NOTICO-CHAT-006-S04 | P1 | ✅ | Given a question sent with a selection; when the session is reopened and the user clicks the selection in the question; then it still shows, and the current tab goes to the page, to the selected text. |

### ai-e2e

(none)
