# UC-CONFLUCO-PANEL-005: Keep long pages for a week

## Behavior

A long page the AI reads, from a tab or by its address, is kept on the device so the AI can read it in parts. Confluco keeps it with the account's chats for 7 days, and no longer.

## Scenarios

### api-test

| ID                        | Priority | Status | Scenario                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-CONFLUCO-PANEL-005-S05 | P1       | ✅     | Given a page the AI read in parts more than 7 days ago; when the side panel opens; then the page's full text is deleted from the device, whether the chat is still saved or was deleted.                                                                                                                                             |

### ai-e2e

(none)
