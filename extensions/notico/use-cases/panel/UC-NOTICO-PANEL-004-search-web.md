# UC-NOTICO-PANEL-004: Search the web

## Behavior

A user asks something that needs current information or sources beyond their Notion and the pages they gave, and the AI searches the web, whichever model answers. The service makes the search (UC-COFUN-WEB-002); the AI gets each result's address, title, and description, can read a result's page in full (UC-NOTICO-PANEL-003), and names the URL of each result it uses. The AI searches with a few keywords, not the user's question as asked. Searches cost credits, as part of what the reply cost.

When searches are turned away for coming too often, web search is unavailable, or credits run out, the question stops; any other failure goes to the AI, and the question goes on.

In Settings, an account can search DuckDuckGo from the browser instead, for free. When DuckDuckGo turns a search away, the question stops and the user is told they can switch it off.

Key constraint:

- What a search returns is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S01 | P0 | ✅ | Given a question that needs the web; when the AI searches; then it gets each result's address, title, and description, marked as data from the search, the tool's card shows the query, and the AI can read a result's page by its address. |
| UC-NOTICO-PANEL-004-S05 | P1 | ✅ | Given a question for which the AI searches the web, one search finding nothing; when the reply ends; then what it cost includes what each search cost. |
| UC-NOTICO-PANEL-004-S06 | P0 | ✅ | Given a user whose credits run out as the AI asks for a search; when it searches; then nothing is searched, the question stops, and the user is told they have no credits, when free ones arrive, and can buy some. |
| UC-NOTICO-PANEL-004-S03 | P1 | ✅ | Given the service or the provider turning searches away for coming too often, or web search not available; when the AI searches; then the question stops, the user is told why, and nothing more is searched for it. |
| UC-NOTICO-PANEL-004-S07 | P1 | ✅ | Given a search that fails, or a service that can't be reached or answers what the extension can't read; when the AI searches; then it is told the search failed, and, when it may have cost credits, not to search for the same again; and the question goes on. |
| UC-NOTICO-PANEL-004-S09 | P0 | ✅ | Given a user who switched on DuckDuckGo in Settings and let Chrome give it access; when the AI searches; then the results come from DuckDuckGo, each with its page's own address, its title, and its description, without its ads, marked as data from the search; the service is not asked to search, and the search costs no credits. |
| UC-NOTICO-PANEL-004-S10 | P1 | ✅ | Given a user who switched DuckDuckGo off again, or removed its access in Chrome, or another account that signs in on the same browser after one switched it on; when the AI searches; then the service searches, as without the setting. |
| UC-NOTICO-PANEL-004-S11 | P1 | ✅ | Given a user switching on DuckDuckGo in Settings; when they decline Chrome's request for access to it; then the switch stays off, and searches go to the service. |
| UC-NOTICO-PANEL-004-S12 | P0 | ✅ | Given DuckDuckGo answering a search with its check that a person is searching, or turning it away for coming too often; when the AI searches; then the question stops, nothing more is searched for it, and the user is told why and that they can switch DuckDuckGo off in Settings. |
| UC-NOTICO-PANEL-004-S13 | P1 | ✅ | Given DuckDuckGo not answering, failing, or answering a page the extension can't read; when the AI searches; then it is told the search failed, and the question goes on. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-004-S04 | P1 | ✅ | Given a user who asks about something recent that no page in the chat says; when the AI answers; then it searches the web, answers from what it found, and names the URLs it used. |
| UC-NOTICO-PANEL-004-S08 | P1 | ✅ | Given a user who asks, as a natural question, about something current that no page in the chat says; when the AI searches; then its query is a few keywords, not the question. |
| UC-NOTICO-PANEL-004-S14 | P1 | 🚧 | Given a user who switched on DuckDuckGo in a real Chrome; when they ask about something recent that no page in the chat says; then the AI searches DuckDuckGo from the extension, answers from what it found, and names the URLs it used. |
