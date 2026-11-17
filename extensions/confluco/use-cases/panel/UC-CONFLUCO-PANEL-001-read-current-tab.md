# UC-CONFLUCO-PANEL-001: Read the current tab

## Behavior

When a question is about the page in the active tab, Confluco can read its main content. The user grants site access in the side panel and in Chrome. The panel also lets the user attach other tabs to a question (UC-CONFLUCO-CHAT-005).

## Scenarios

### api-test

| ID                        | Priority | Status | Scenario                                                                                                                                                                                                                                 |
| ------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-PANEL-001-S11 | P0       | ✅     | Given a site the user allowed and a page open on it; when the AI reads the current tab; then it gets the main content as Markdown, marked as page data with its title and URL.                                                           |
| UC-CONFLUCO-PANEL-001-S12 | P0       | ✅     | Given a site the user has yet to allow; when the AI tries to read the current tab; then it reads only after the user grants access on the tool card and in Chrome, and the tab still shows the same page. A denial is shown as declined. |
| UC-CONFLUCO-PANEL-001-S13 | P0       | ✅     | Given the current tab is on a site Confluco needs for sign-in; when the assistant is asked to read it; then the contents stay out of the conversation.                                                                                   |

### ai-e2e

(none)
