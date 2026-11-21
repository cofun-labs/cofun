# UC-NOTICO-PANEL-001: Open the side panel on any tab

## Behavior

A user opens the AI side panel from the extension's toolbar icon on any tab, and it stays open, with its conversation, as they switch tabs. Reading and changing Notion works only while the current tab is a Notion page; on another tab the AI is told just that, and tells the user to switch when a request needs Notion.

Key constraint:

- The AI works on the current tab only. A Notion page open in another tab is never used in its place.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S03 | P0 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks a question; then the AI answers, having been told only that the current tab is not a Notion page, not its address or title. |
| UC-NOTICO-PANEL-001-S04 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the AI tries to read or change Notion; then nothing is asked of Notion, and the AI is told to have the user switch to a Notion page. |
| UC-NOTICO-PANEL-001-S10 | P0 | ✅ | Given another Notion page open in a tab in the background; when the AI reads "this page" with a Notion page in the current tab, and then with another site in the current tab; then the first reads the current tab's page, in that tab, and the second asks nothing of Notion in any tab and tells the AI to have the user switch to a Notion page. |
| UC-NOTICO-PANEL-001-S13 | P1       | ✅     | Given a Notion page in the current tab; when the AI reads it as a page on any site; then nothing is read from the tab, and the AI is told to read it with Notico's Notion tools. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S01 | P0 | ✅ | Given a Notion page, or another site, in the active tab; when the user clicks the toolbar icon; then the side panel opens next to it. |
| UC-NOTICO-PANEL-001-S07 | P1 | ✅ | Given a conversation in the side panel on a Notion page; when the user switches to a tab on another site; then the panel stays open with the conversation, and the next question continues it. |
| UC-NOTICO-PANEL-001-S09 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks for something that needs Notion, such as a summary of this page; then the AI says it needs a Notion page and asks them to switch to one, without making anything up. |
| UC-NOTICO-PANEL-001-S16 | P1 | ✅ | Given an article on an allowed site in Chrome, with headings, a list, a link, a table, and content the page hides (a closed menu, a collapsed section); when the user asks to save the page to a new Notion page; then the Notion page keeps the headings, the list, the link, and the table, and holds nothing of what the page hid. |
