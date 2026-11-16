# UC-CONFLUCO-CONFLUENCE-001: Read a connected page

## Behavior

A signed-in user connects their self-managed Confluence instance and grants Chrome access to that site. On a published page in the connected instance, the assistant can read the page with the user's Confluence session and answer from it.

### api-test

| ID                             | Priority | Status | Scenario                                                                                                                                                                        |
| ------------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-CONFLUENCE-001-S01 | P0       | ✅     | Given a published page in the active tab; when the user connects its instance, grants access, and asks about it; then the assistant receives the page text and its source link. |
