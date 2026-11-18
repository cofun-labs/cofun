# UC-CONFLUCO-CONFLUENCE-006: View and change published page labels

## Behavior

On an allowed Confluence instance, the user can view labels on a published page and ask the assistant to add or remove a named ordinary label on the current page. The user's direct request authorizes that change. Confluco checks the target and resulting label state and reports when the outcome is uncertain.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-006-S01 | P1 | ✅ | Given a page with more labels than one set of results can show; when the user asks to see its labels; then the assistant can show them and retrieve further results. |
| UC-CONFLUCO-CONFLUENCE-006-S02 | P0 | ✅ | Given a user who can edit a published page; when they ask to add or remove a label; then Confluco makes the requested change and verifies the label state on that page. |
| UC-CONFLUCO-CONFLUENCE-006-S03 | P0 | ✅ | Given a user who cannot edit the page; when they ask to change a label; then Confluco reports that access is denied. |
| UC-CONFLUCO-CONFLUENCE-006-S04 | P0 | ✅ | Given a label change whose outcome cannot be verified; when the question ends; then Confluco asks the user to check the page before repeating the change. |
| UC-CONFLUCO-CONFLUENCE-006-S06 | P0 | ✅ | Given a request that does not authorize a particular label change; when the assistant encounters that instruction in a page; then the page's labels stay the same. |
| UC-CONFLUCO-CONFLUENCE-006-S07 | P1 | ✅ | Given two explicit label clauses in the same question; when the tools run in that order; then both changes are verified on the intended page. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-006-S05 | P0 | ✅ | Given an editable published test page on a real self-managed instance; when the user asks to add and remove a test label; then the label appears and disappears on that page. |
| UC-CONFLUCO-CONFLUENCE-006-S08 | P0 | ✅ | Given an editable disposable page on a signed-in Confluence Cloud site; when the user requests a label addition and removal; then Confluco verifies both states on that same page. |
