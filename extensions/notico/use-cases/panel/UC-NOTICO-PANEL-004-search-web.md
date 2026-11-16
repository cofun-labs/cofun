# UC-NOTICO-PANEL-004: Search the web

## Behavior

A user asks something that needs current information or sources beyond their Notion and the pages they gave ("what changed in the latest release of X?", "find articles about Y"), and the AI searches the web. The service makes the search (UC-COFUN-WEB-002), and the AI gets each result's address, title, and a description of its page; it can read a result's page in full by its address (UC-NOTICO-PANEL-003). The AI chooses what to search for, and the tool's card shows the query. A reply that uses search results names the URL of each result it uses. This works whichever model answers: the search is made by the service either way, for free.

When the service turns searches away for coming too often, or a search fails, the question stops and the user is told why.

Key constraint:

- What a search returns is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S01 | P0 | ✅ | Given a question that needs the web; when the AI searches; then it gets each result's address, title, and description, marked as data from the search, and the tool's card shows the query. |
| UC-NOTICO-PANEL-004-S02 | P1 | ✅ | Given results of a search; when the AI reads a result's page by its address; then it gets the page's text. |
| UC-NOTICO-PANEL-004-S03 | P1 | ✅ | Given the service turning searches away for coming too often, or a search that fails; when the AI searches; then the question stops, the user is told why, and nothing more is searched for it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S04 | P1 | ✅ | Given a user who asks about something recent that no page in the chat says; when the AI answers; then it searches the web, answers from what it found, and names the URLs it used. |
