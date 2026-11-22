# UC-CONFLUCO-CONFLUENCE-009: Edit text on a published Confluence page

## Behavior

A user on an allowed instance can ask the assistant to change text on a published page. The model replaces a passage that appears once on the page with new text that it chooses, without asking first; the tool's card shows the page, the passage and its replacement. A verified edit preserves the page's identity, location, and unrelated published content and formatting. On Cloud, publishing the edit can merge into or overwrite an unpublished draft. Confluco offers no undo: the user restores an earlier version from the page history in Confluence.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-009-S01 | P0 | ✅ | Given a published page with a unique passage and other formatted content; when the model replaces the passage; then the card shows the intended change and Confluco verifies that only that text changed. |
| UC-CONFLUCO-CONFLUENCE-009-S02 | P1 | ✅ | Given a passage that appears more than once or not at all; when the model asks to replace it; then the page remains unchanged and the model is told to quote one current passage. |
| UC-CONFLUCO-CONFLUENCE-009-S03 | P0 | ✅ | Given a page changes after an edit is proposed; when the old proposal is applied; then Confluco preserves the newer content and asks the user to review the current page. |
| UC-CONFLUCO-CONFLUENCE-009-S04 | P0 | ✅ | Given a write has an uncertain outcome; when Confluco can verify the resulting page; then it reports the verified edit, otherwise it asks the user to check without repeating the write. |
| UC-CONFLUCO-CONFLUENCE-009-S09 | P1 | ✅ | Given Confluence explicitly refuses the write because sign-in is required; when the user asks to edit the page; then the question stops with a sign-in message and sends no verification read. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-009-S05 | P1 | ✅ | Given a disposable published page with a macro, table, and attachment on a real instance; when the user requests a targeted edit; then the published page contains the new text and retains the unrelated content and attachment. |
