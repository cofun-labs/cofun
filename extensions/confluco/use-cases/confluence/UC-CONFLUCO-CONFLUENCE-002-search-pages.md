# UC-CONFLUCO-CONFLUENCE-002: Search published pages

## Behavior

A user can search published pages on the connected self-managed Confluence instance. The assistant gets the matches and their links through the user's Confluence session.

### api-test

| ID                             | Priority | Status | Scenario                                                                                                                                                                 |
| ------------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-CONFLUCO-CONFLUENCE-002-S01 | P0       | ✅     | Given a connected instance with a published page that matches; when the user asks to search by title; then the assistant receives the matching page and its source link. |
