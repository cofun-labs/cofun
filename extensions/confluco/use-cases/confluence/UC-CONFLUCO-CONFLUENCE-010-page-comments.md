# UC-CONFLUCO-CONFLUENCE-010: Read and contribute to a page discussion

## Behavior

A user can read a published page's comments in bounded batches and follow links to the discussion. Where Confluence identifies comment locations, Confluco distinguishes footer and inline comments. A direct request can add a footer comment or reply to a specific footer comment after showing the page, reply target and exact text.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-010-S01 | P0 | ✅ | Given a page with a discussion; when the user reads its comments; then Confluco returns a bounded batch with source links, parent relationships and a way to continue. |
| UC-CONFLUCO-CONFLUENCE-010-S02 | P0 | ✅ | Given a direct footer comment or reply request; when Confluco applies it; then it previews the exact target and text and verifies the published result. |
| UC-CONFLUCO-CONFLUENCE-010-S03 | P0 | ✅ | Given an unauthorized target, an inline reply target, or denied access; when a comment is requested; then Confluco reports the restriction without posting elsewhere. |
| UC-CONFLUCO-CONFLUENCE-010-S04 | P0 | ✅ | Given the outcome of a comment write is uncertain; when Confluco cannot verify it; then it asks the user to check the discussion without posting again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-010-S05 | P0 | ✅ | Given a real disposable published page; when the user adds a footer comment and replies to it; then the page displays the exact texts in the intended thread. |
| UC-CONFLUCO-CONFLUENCE-010-S06 | P0 | ✅ | Given a disposable page on a signed-in Confluence Cloud site; when the user posts a footer comment and replies to it; then the discussion contains the exact texts and the requested reply relationship. |
