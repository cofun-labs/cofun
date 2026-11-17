# UC-CONFLUCO-CONFLUENCE-002: Read a published page

## Behavior

A user asks about a published page in their current tab on the connected self-managed Confluence site. Confluco uses that tab's Confluence session, reads the published page as text, and gives the model the result as page data with a source link. A missing permission or a failed request is explained to the user.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-002-S01 | P0 | ✅ | Given a published page at the connected site; when the model asks to read it; then the request runs in that tab and the model receives plain text marked as page data with the page title and source link. |
| UC-CONFLUCO-CONFLUENCE-002-S02 | P0 | ✅ | Given a tab outside the connected site or a page that changes before the read starts; when the model asks to read it; then no Confluence request is sent. |
| UC-CONFLUCO-CONFLUENCE-002-S03 | P0 | ✅ | Given a site that refuses because the session is absent, access is denied, or the user is rate-limited; when the model asks to read a page; then the question stops and the user sees the appropriate reason. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-002-S04 | P1 | ✅ | Given a published page in a real signed-in Confluence tab; when a question calls the read tool; then the panel shows a completed Confluence read with the page's source link. |
