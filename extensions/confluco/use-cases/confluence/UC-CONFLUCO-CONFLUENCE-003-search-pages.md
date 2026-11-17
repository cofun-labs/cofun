# UC-CONFLUCO-CONFLUENCE-003: Search published pages

## Behavior

A user searches for published pages on the connected Confluence site. Search terms and any space key come from the user's current question. Confluence searches titles or content under the tab's site session and returns results visible to that account. The model gets titles, excerpts, and source links, plus a continuation if another page is available. The model can use the continuation for the same search during the question.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-003-S01 | P0 | ✅ | Given a connected site and a search with text, a field, and a space key; when the model runs it; then the model gets published-page results with plain excerpts, source links, and a continuation, with the filters kept. |
| UC-CONFLUCO-CONFLUENCE-003-S02 | P0 | ✅ | Given a next link that points outside the connected instance's search endpoint; when results are returned; then no link is followed and the model gets no continuation from it. |
| UC-CONFLUCO-CONFLUENCE-003-S04 | P0 | ✅ | Given search terms or a space key absent from the current user question; when the model proposes them; then no search request is sent and the model is told which input needs to come from the user. |
| UC-CONFLUCO-CONFLUENCE-003-S05 | P0 | ✅ | Given a continuation from a different search or one the tool did not return in this question; when the model proposes it; then no request is sent with that continuation. |
| UC-CONFLUCO-CONFLUENCE-003-S06 | P0 | ✅ | Given a Cloud search with title and space filters and another page; when the model uses the continuation; then the same query fetches the next page in that tab and the model receives source links. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-003-S03 | P1 | ✅ | Given a real signed-in site; when the model searches for a visible published page; then the panel shows Confluence results with source links at the connected site. |
| UC-CONFLUCO-CONFLUENCE-003-S07 | P0 | ✅ | Given a real signed-in Cloud site with published search matches; when a question uses the search tool and its continuation; then the panel shows the search results and the next page from the same site. |
