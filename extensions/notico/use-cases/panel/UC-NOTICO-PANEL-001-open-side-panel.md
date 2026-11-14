# UC-NOTICO-PANEL-001: Open the side panel on any tab

## Behavior

A user opens the AI side panel from the extension's toolbar icon on any tab, and can chat there. The panel stays open, with its conversation, as the user switches tabs, to a Notion page or away from one.

Reading and changing Notion works only while the current tab is a Notion page. On any other tab the AI is told just that: that the current tab is not a Notion page. It still answers what it can, and when a request needs Notion it tells the user to switch to a Notion page. When a question needs to know where the user is, the AI can look up the current tab's address and title, on Notion or any other site.

Key constraints:

- The AI works on the current tab only. A Notion page open in another tab is never used in its place.
- The address and title of a tab on another site reach the AI only when it looks them up to answer a question. Nothing else of other sites is read: not their content, and no other tab.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S03 | P0 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks a question; then the AI answers, having been told only that the current tab is not a Notion page, not its address or title. |
| UC-NOTICO-PANEL-001-S04 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the AI tries to read or change Notion; then nothing is asked of Notion, and the AI is told to have the user switch to a Notion page. |
| UC-NOTICO-PANEL-001-S05 | P1 | ✅ | Given the side panel open on a tab on another site; when the AI looks up the current tab; then it gets that tab's address and title, and nothing else of the site. |
| UC-NOTICO-PANEL-001-S06 | P1 | ✅ | Given the side panel open on a Notion page; when the AI looks up the current tab; then it gets that tab's address and title. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S01 | P0 | ✅ | Given a Notion page in the active tab; when the user clicks the toolbar icon; then the side panel opens next to the page. |
| UC-NOTICO-PANEL-001-S08 | P0 | ✅ | Given another site in the active tab; when the user clicks the toolbar icon; then the side panel opens next to it. |
| UC-NOTICO-PANEL-001-S07 | P1 | ✅ | Given a conversation in the side panel on a Notion page; when the user switches to a tab on another site; then the panel stays open with the conversation, and the next question continues it. |
| UC-NOTICO-PANEL-001-S09 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks for something that needs Notion, such as a summary of this page; then the AI says it needs a Notion page and asks them to switch to one, without making anything up. |
