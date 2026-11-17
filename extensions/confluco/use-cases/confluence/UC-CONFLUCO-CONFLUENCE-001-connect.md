# UC-CONFLUCO-CONFLUENCE-001: Connect a self-managed site

## Behavior

A signed-in Cofun user connects one self-managed Confluence site from Settings. They enter its base URL, including any deployment context, and approve Chrome access. Confluco keeps the connection for that Cofun account. Disconnecting removes the saved connection and releases access granted for the connection when no other connection uses it. Existing Chrome site access is kept.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S01 | P0 | ✅ | Given a valid base URL; when the user grants site access; then the connection survives reopening the panel and can be disconnected in Settings. |
| UC-CONFLUCO-CONFLUENCE-001-S02 | P0 | ✅ | Given a valid base URL; when the user declines Chrome access; then the site is left disconnected and the panel explains why. |
| UC-CONFLUCO-CONFLUENCE-001-S03 | P1 | ✅ | Given an Atlassian Cloud URL; when the user submits it; then the panel asks for a self-managed base URL without requesting site access. |
| UC-CONFLUCO-CONFLUENCE-001-S05 | P0 | ✅ | Given existing Chrome access to a site; when the user connects and disconnects it; then that existing access is kept. |
| UC-CONFLUCO-CONFLUENCE-001-S06 | P1 | ✅ | Given Settings is open in two windows; when the user disconnects in one; then the other reflects the saved connection without reopening Settings. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S04 | P1 | ✅ | Given a real Chrome profile; when the user connects a self-managed site and reopens the panel; then Settings shows the saved site and Chrome access permits the read tools to run. |
