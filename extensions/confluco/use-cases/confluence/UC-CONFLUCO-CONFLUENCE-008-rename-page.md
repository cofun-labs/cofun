# UC-CONFLUCO-CONFLUENCE-008: Rename a published Confluence page

## Behavior

On an allowed instance, the user can ask for a new title for a published page, and the model chooses it, without asking first. The tool's card shows the intended page and title. Confluco keeps the page's content and location, and checks the resulting page. Confluco stops when it detects that the page advanced before writing and reports when the outcome is uncertain.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-008-S01 | P0 | ✅ | Given a published page with existing content; when the user requests a new title; then the title changes and the same page retains its content and parent. |
| UC-CONFLUCO-CONFLUENCE-008-S02 | P0 | ✅ | Given a self-managed published page changes after Confluco prepares the rename; when the rename would overwrite the newer version; then the newer version is preserved. |
| UC-CONFLUCO-CONFLUENCE-008-S03 | P0 | ✅ | Given the account cannot rename the page or the outcome cannot be verified; when the user requests the rename; then Confluco explains the failure or uncertainty. |
| UC-CONFLUCO-CONFLUENCE-008-S06 | P0 | ✅ | Given a published Cloud page changes after Confluco prepares the rename; when Confluco sees a newer revision in its last read before the write; then it leaves the page alone. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-008-S04 | P1 | ✅ | Given a disposable published page on a real self-managed instance; when the user requests a rename; then the same page has the new title and still has its original content and parent. |
| UC-CONFLUCO-CONFLUENCE-008-S05 | P1 | ✅ | Given a disposable published page on a signed-in Confluence Cloud site; when the user requests a rename; then the same page has the new title and retains its body and parent. |
