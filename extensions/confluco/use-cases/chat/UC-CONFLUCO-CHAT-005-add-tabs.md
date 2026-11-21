# UC-CONFLUCO-CHAT-005: Add open tabs to a conversation

## Behavior

A signed-in user brings pages from other sites into a chat, for questions like "compare these three pages", by adding the tabs that show them from Confluco's page picker. Picking a tab on a site Confluco may not read yet asks Chrome for the user's permission first. The question carries the tabs' titles and addresses, and nothing of them is read ahead of it.

Key constraint:

- Listing the tabs reads only their titles and addresses, which stay in the browser until the user adds one.

## Scenarios

### api-test

| ID                       | Priority | Status | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-CHAT-005-S01 | P1       | ✅     | Given tabs on other sites in the side panel's window, a browser page, and a tab in another window; when the user opens the picker and types; then it lists the window's tabs on other sites by title and site, filtered by what is typed, leaves out the browser page and the other window's tab, and reads nothing of them.                                                                                                                                                           |
| UC-CONFLUCO-CHAT-005-S02 | P0       | ✅     | Given a tab on a site Confluco may not read; when the user picks it; then Chrome is asked to let Confluco read that site, the tab is added once the user allowed it there, and when they say no it is not added and the picker says why; and a tab on a site already allowed is added without asking.                                                                                                                                                                                  |
| UC-CONFLUCO-CHAT-005-S03 | P1       | ✅     | Given tabs added to a question; when it is sent; then the AI is told their titles and addresses, nothing of them is read ahead of it, the question shows them, also after the session is reopened, and clicking one goes to its tab.                                                                                                                                                                                                                                                   |

### ai-e2e

(none)
