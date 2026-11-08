# UC-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in.

Key constraint:

- The server chooses the model. Clients cannot use another one.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-001-S01 | P0 | verified | Given a signed-in user; when they ask the AI something; then the reply streams back to the extension piece by piece and adds up to the full answer. |
| UC-CHAT-001-S02 | P1 | verified | Given a signed-in user; when a client asks for a model other than the server's; then the request is refused and no model is called. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-001-S03 | P0 | verified | Given a signed-in user with the side panel open on Notion; when they send a message; then the message appears and the reply streams in below it. |
