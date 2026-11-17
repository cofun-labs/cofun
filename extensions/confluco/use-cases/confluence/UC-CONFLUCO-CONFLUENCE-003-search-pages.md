# UC-CONFLUCO-CONFLUENCE-003: Search published pages

## Behavior

A user searches for published pages on the connected self-managed Confluence site. Search terms and any space key come from the user's current question. Confluence searches titles or content under the tab's site session and returns results visible to that account. The model gets titles, excerpts, and source links, plus an offset if another page of results is available.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-003-S01 | P0 | ✅ | Given a connected site and a search with text, a field, and a space key; when the model runs it; then the model gets published-page results with plain excerpts, source links, and the next offset, with the filters kept. |
| UC-CONFLUCO-CONFLUENCE-003-S02 | P0 | ✅ | Given a next link that points outside the connected instance's search endpoint; when results are returned; then no link is followed and the model gets no next offset from it. |
| UC-CONFLUCO-CONFLUENCE-003-S04 | P0 | ✅ | Given search terms or a space key absent from the current user question; when the model proposes them; then no search request is sent and the model is told which input needs to come from the user. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-003-S03 | P1 | ✅ | Given a real signed-in site; when the model searches for a visible published page; then the panel shows Confluence results with source links at the connected site. |
