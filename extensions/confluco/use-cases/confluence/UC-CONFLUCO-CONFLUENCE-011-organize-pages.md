# UC-CONFLUCO-CONFLUENCE-011: Move and copy a published Confluence page

## Behavior

A user can ask the assistant to move published pages beneath a parent in the same space, or copy a page's body into a new single page there: the model chooses the pages, the parent, and a copy's title, without asking first. The tool's card shows the source and destination. Confluco refuses a move or copy that could drop an existing access restriction, and verifies the new ancestry.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-011-S01 | P0 | ✅ | Given a published page and an eligible parent in the same space; when the model moves the page there; then the same page is verified under that parent. |
| UC-CONFLUCO-CONFLUENCE-011-S02 | P0 | ✅ | Given a published page eligible for a body-only copy; when the model copies it under a parent with a title; then a new page is verified at that destination and the source remains intact. |
| UC-CONFLUCO-CONFLUENCE-011-S03 | P0 | ✅ | Given a parent in another space, a page a copy can't keep whole, or a move or copy that could drop an existing restriction; when the model asks for it; then Confluco refuses the write and tells the model why. |
| UC-CONFLUCO-CONFLUENCE-011-S04 | P0 | ✅ | Given a source or destination changes after preview, or a write outcome cannot be verified; when Confluco applies the plan; then it protects newer work or asks the user to verify without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-011-S05 | P1 | ✅ | Given disposable pages on a real instance; when the user moves and copies a page; then the same original and the distinct copy appear beneath their chosen parent with the expected body. |
| UC-CONFLUCO-CONFLUENCE-011-S06 | P1 | ✅ | Given disposable pages on a signed-in Confluence Cloud site; when the user moves a published page and copies its body within the space; then the original and the distinct copy are verified beneath the chosen parent with the same body. |
