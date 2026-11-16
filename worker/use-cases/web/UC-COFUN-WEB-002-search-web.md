# UC-COFUN-WEB-002: Search the web

## Behavior

A signed-in user's client can have the service search the web for them: it gets the results, each with its page's address, title, and a short description of the page, up to as many as it asks for. Searching is free, and a user can make only a few searches a minute. The search goes to one fixed search provider, which keeps no data of it; the service never keeps or logs the query or the results.

What to search for is the client's choice (UC-NOTICO-PANEL-004).

Key constraint:

- A search that fails, for a reason the service knows or not, gives no results and is not tried again: the client is told it failed.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-WEB-002-S01 | P0 | ✅ | Given a signed-in user; when their client searches the web; then it gets each result's address, title, and description, no more results than it asked for, and nothing is charged. |
| UC-COFUN-WEB-002-S02 | P1 | ✅ | Given a user who has made as many searches as they may in a minute; when their client searches again; then they are told to wait, and nothing is searched. |
| UC-COFUN-WEB-002-S03 | P1 | ✅ | Given a search the provider turns away or answers in a way the service does not understand; when a client searches; then it is told the search failed, and it is not tried again. |

### ai-e2e

(none)
