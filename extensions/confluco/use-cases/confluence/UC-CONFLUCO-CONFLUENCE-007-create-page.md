# UC-CONFLUCO-CONFLUENCE-007: Create a published Confluence page

## Behavior

On an allowed instance, the user can ask for a published page, and the model chooses its title, plain-text body, and parent, without asking first. The tool's card shows the intended site, parent and title. Confluco checks the result, avoids duplicate creation, and reports when the outcome cannot be confirmed. Read only turns creation off.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-007-S01 | P0 | ✅ | Given a user who can create a page under a parent; when the model creates one with a title and body; then the card shows the intended change and Confluco verifies the created page under that parent. |
| UC-CONFLUCO-CONFLUENCE-007-S02 | P1 | ✅ | Given a page with the requested title already exists in the chosen space; when the user requests creation; then Confluco reports the existing page without creating another. |
| UC-CONFLUCO-CONFLUENCE-007-S03 | P0 | ✅ | Given creation is denied or its outcome is uncertain; when the user requests a page; then Confluco reports the failure or asks the user to check the page. |
| UC-CONFLUCO-CONFLUENCE-007-S06 | P0 | ✅ | Given a direct creation request in Read only; when the model calls the write tool; then the user is told it is blocked and no site request is sent. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-007-S05 | P1 | ✅ | Given an editable parent in a real self-managed Confluence instance; when the user requests a disposable child page; then the published child has the requested title and content. |
| UC-CONFLUCO-CONFLUENCE-007-S07 | P1 | ✅ | Given an editable parent on a signed-in Confluence Cloud site; when the user requests a disposable child page; then the published child has the requested title and content under that parent. |
