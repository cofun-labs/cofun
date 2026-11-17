# UC-CONFLUCO-CONFLUENCE-001: Connect a Confluence site

## Behavior

A signed-in Cofun user connects one Confluence Cloud or self-managed site from Settings. They enter its base URL and approve Chrome access. A Cloud site can be entered by its tenant origin or its wiki root, and the connection is saved at the wiki root. A self-managed URL includes any deployment context. Confluco keeps the connection for that Cofun account. Disconnecting removes the saved connection and releases access granted for the connection when no other connection uses it. Existing Chrome site access is kept.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S01 | P0 | ✅ | Given a valid base URL; when the user grants site access; then the connection survives reopening the panel and can be disconnected in Settings. |
| UC-CONFLUCO-CONFLUENCE-001-S02 | P0 | ✅ | Given a valid base URL; when the user declines Chrome access; then the site is left disconnected and the panel explains why. |
| UC-CONFLUCO-CONFLUENCE-001-S03 | P1 | ✅ | Given an Atlassian-hosted Cloud origin; when the user grants site access; then the saved connection points to its wiki root and can be disconnected. |
| UC-CONFLUCO-CONFLUENCE-001-S05 | P0 | ✅ | Given existing Chrome access to a site; when the user connects and disconnects it; then that existing access is kept. |
| UC-CONFLUCO-CONFLUENCE-001-S06 | P1 | ✅ | Given Settings is open in two windows; when the user disconnects in one; then the other reflects the saved connection without reopening Settings. |
| UC-CONFLUCO-CONFLUENCE-001-S07 | P1 | ✅ | Given a Cloud URL to an individual page; when the user enters it in Settings; then the panel asks for the site URL before requesting Chrome access. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S04 | P1 | ✅ | Given a real Chrome profile; when the user connects a self-managed site and reopens the panel; then Settings shows the saved site and Chrome access permits the read tools to run. |
| UC-CONFLUCO-CONFLUENCE-001-S08 | P0 | ✅ | Given a real Chrome profile and a signed-in Atlassian-hosted Cloud site; when the user connects that site; then Settings saves the wiki URL and the extension can use the tab session. |
