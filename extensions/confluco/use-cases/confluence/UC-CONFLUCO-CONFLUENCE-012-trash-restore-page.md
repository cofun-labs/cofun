# UC-CONFLUCO-CONFLUENCE-012: Trash and restore a Confluence page

## Behavior

A user can move an eligible published page to recoverable trash and restore a trashed page to the space root. The assistant previews the exact page and verifies its resulting state. The user reviews the possible impact on the page hierarchy before trashing. In the same conversation, an explicit undo request can restore the latest verified trash action while the page still matches that action. When the assistant cannot establish which trash action it would reverse, the user reviews access at the space root before restoring.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-012-S01 | P0 | ✅ | Given an eligible published page; when the user asks to move it to the trash and confirms the effect on the page hierarchy; then Confluco moves that page to recoverable trash and verifies its state. |
| UC-CONFLUCO-CONFLUENCE-012-S02 | P0 | ✅ | Given a trashed page; when the user confirms restoration by link or undoes its verified trash action; then Confluco verifies that the same page is published again. |
| UC-CONFLUCO-CONFLUENCE-012-S03 | P0 | ✅ | Given a page already in the requested state, a different target, an ineligible page, or denied access; when a change is requested; then Confluco reports the outcome without changing an unintended page. |
| UC-CONFLUCO-CONFLUENCE-012-S04 | P0 | ✅ | Given the result of trash or restore is uncertain; when the new state cannot be verified; then Confluco asks the user to check without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-012-S05 | P0 | ✅ | Given a real disposable published page; when the user moves it to the trash and undoes the action; then Confluco verifies both states and the same page is available again. |
