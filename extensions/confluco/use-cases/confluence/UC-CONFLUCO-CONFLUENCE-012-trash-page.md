# UC-CONFLUCO-CONFLUENCE-012: Move a Confluence page to the trash

## Behavior

A user can ask the assistant to move an eligible published page to the recoverable trash on an allowed Cloud or self-managed site. It is the one change that asks first: the card names the page and the possible impact on the page hierarchy, and nothing is sent until the user allows it. Confluco verifies the page's resulting state. It never restores a page: the user does that from the space's trash in Confluence, which may restore it at the space root and change its inherited access.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-012-S01 | P0 | ✅ | Given an eligible published page; when the user asks to move it to the trash and confirms the effect on the page hierarchy; then Confluco moves that page to recoverable trash and verifies its state. |
| UC-CONFLUCO-CONFLUENCE-012-S03 | P1 | ✅ | Given a page already in the trash, a top-level page, a page with child pages, a page whose access could change, or a declined card; when the model asks to trash it; then Confluco reports the outcome without changing any page. |
| UC-CONFLUCO-CONFLUENCE-012-S04 | P0 | ✅ | Given the result of a trash action is uncertain; when the new state cannot be verified; then Confluco asks the user to check without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-012-S05 | P1 | ✅ | Given a real disposable published page on a self-managed site; when the user confirms moving it to the trash; then Confluco verifies the same page in recoverable trash. |
| UC-CONFLUCO-CONFLUENCE-012-S06 | P1 | ✅ | Given an eligible disposable page on a signed-in Confluence Cloud site; when the user confirms moving it to the trash; then the extension verifies the same page in recoverable trash. |
