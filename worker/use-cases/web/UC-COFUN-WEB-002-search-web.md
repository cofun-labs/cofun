# UC-COFUN-WEB-002: Search the web

## Behavior

A signed-in user's client can have the service search the web for them, and gets each result's address, title, and a short description of its page. A search costs the search provider's list price, 0.25 credit, with nothing added, and goes ahead only while the user has credits left, a few a minute. The search goes to one fixed search provider, which keeps no data of it; the service never keeps or logs the query or the results.

What to search for is the client's choice (UC-NOTICO-PANEL-004).

Key constraint:

- A search that fails, for a reason the service knows or not, gives no results and is not tried again: the client is told it failed.
- Only a search that gave results, none included, is charged; one that fails costs nothing, whatever the provider bills for it. The answer says what the search cost, results or not.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-WEB-002-S01 | P0 | ✅ | Given a signed-in user; when their client searches the web; then it gets each result's address, title, and description, no more results than it asked for, and the search is charged 0.25 credit, as the answer says. |
| UC-COFUN-WEB-002-S02 | P1 | ✅ | Given a user who has made as many searches as they may in a minute; when their client searches again; then they are told to wait, and nothing is searched. |
| UC-COFUN-WEB-002-S03 | P1 | ✅ | Given a search the provider turns away or answers in a way the service does not understand; when a client searches; then it is told the search failed, and it is not tried again. |
| UC-COFUN-WEB-002-S04 | P0 | ✅ | Given a user with no credits left; when their client searches the web; then it is told they have no credits and when free ones arrive, and nothing is searched. |
| UC-COFUN-WEB-002-S05 | P1 | ✅ | Given a search that fails, whether the provider turned it away, answered in a way the service does not understand, or brought no answer; when a client searches; then it costs nothing, and the refusal says so. |

### ai-e2e

(none)
