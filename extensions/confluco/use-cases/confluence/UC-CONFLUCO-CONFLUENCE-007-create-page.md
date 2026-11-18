# UC-CONFLUCO-CONFLUENCE-007: Create a published Confluence page

## Behavior

On an allowed instance, the user can request a published page with a title and optional plain text, under a parent they choose. Confluco shows the intended site, parent and title before writing. It checks the result, avoids duplicate creation, and reports when the outcome cannot be confirmed.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-007-S01 | P0 | ✅ | Given a user who can create a page under the chosen parent; when they request a title and body; then the assistant shows the intended change and verifies the created page under that parent. |
| UC-CONFLUCO-CONFLUENCE-007-S02 | P0 | ✅ | Given a page with the requested title already exists in the chosen space; when the user requests creation; then Confluco reports the existing page without creating another. |
| UC-CONFLUCO-CONFLUENCE-007-S03 | P0 | ✅ | Given creation is denied or its outcome is uncertain; when the user requests a page; then Confluco reports the failure or asks the user to check the page. |
| UC-CONFLUCO-CONFLUENCE-007-S04 | P0 | ✅ | Given the user did not authorize a particular new title or parent; when the assistant is induced to create it; then Confluco does not create the page. |
| UC-CONFLUCO-CONFLUENCE-007-S06 | P0 | ✅ | Given a direct creation request in Read only; when the model calls the write tool; then the user is told it is blocked and no site request is sent. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-007-S05 | P0 | ✅ | Given an editable parent in a real self-managed Confluence instance; when the user requests a disposable child page; then the published child has the requested title and content. |
| UC-CONFLUCO-CONFLUENCE-007-S07 | P0 | ✅ | Given an editable parent on a signed-in Confluence Cloud site; when the user requests a disposable child page; then the published child has the requested title and content under that parent. |
