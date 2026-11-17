# UC-CONFLUCO-CHAT-001: Ask from the side panel

## Behavior

A signed-in user asks a question and reads the AI’s reply as it streams. They can stop a reply while it is being written.

## Scenarios

### api-test

| ID                       | Priority | Status | Scenario                                                                                                                        |
| ------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-CHAT-001-S03 | P0       | ✅     | Given a signed-in user; when they send a question; then their message appears and the reply streams beneath it.                 |
| UC-CONFLUCO-CHAT-001-S04 | P1       | ✅     | Given a reply is streaming; when the user clicks Stop; then the reply stops and the composer is available for another question. |

### ai-e2e

(none)
