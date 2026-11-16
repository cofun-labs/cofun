# UC-NOTICO-PANEL-004: Search the web

## Behavior

A user asks something that needs current information or sources beyond their Notion and the pages they gave, and the AI searches the web, whichever model answers. The service makes the search (UC-COFUN-WEB-002); the AI gets each result's address, title, and description, can read a result's page in full (UC-NOTICO-PANEL-003), and names the URL of each result it uses. Searches cost credits, as part of what the reply cost.

When searches are turned away for coming too often, web search is unavailable, or credits run out, the question stops; any other failure goes to the AI, and the question goes on.

Key constraint:

- What a search returns is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S01 | P0 | ✅ | Given a question that needs the web; when the AI searches; then it gets each result's address, title, and description, marked as data from the search, and the tool's card shows the query. |
| UC-NOTICO-PANEL-004-S02 | P1 | ✅ | Given results of a search; when the AI reads a result's page by its address; then it gets the page's text. |
| UC-NOTICO-PANEL-004-S05 | P1 | ✅ | Given a question for which the AI searches the web, one search finding nothing; when the reply ends; then what it cost includes what each search cost. |
| UC-NOTICO-PANEL-004-S06 | P0 | ✅ | Given a user whose credits run out as the AI asks for a search; when it searches; then nothing is searched, the question stops, and the user is told they have no credits, when free ones arrive, and can buy some. |
| UC-NOTICO-PANEL-004-S03 | P1 | ✅ | Given the service or the provider turning searches away for coming too often, or web search not available; when the AI searches; then the question stops, the user is told why, and nothing more is searched for it. |
| UC-NOTICO-PANEL-004-S07 | P1 | ✅ | Given a search that fails, or a service that can't be reached or answers what the extension can't read; when the AI searches; then it is told the search failed, and, when it may have cost credits, not to search for the same again; and the question goes on. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S04 | P1 | ✅ | Given a user who asks about something recent that no page in the chat says; when the AI answers; then it searches the web, answers from what it found, and names the URLs it used. |
