# UC-CONFLUCO-CONFLUENCE-003: Confirm a text replacement

## Behavior

A user can request an exact text replacement on a published page. Confluco previews the old and new text and waits for confirmation before writing, then checks the resulting page.

### api-test

| ID                             | Priority | Status | Scenario                                                                                                                                                                             |
| ------------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-CONFLUCO-CONFLUENCE-003-S01 | P0       | ✅     | Given a direct request to replace a unique passage; when the user confirms the preview; then Confluco applies one edit, preserves surrounding content, and verifies the new version. |
| UC-CONFLUCO-CONFLUENCE-003-S02 | P0       | ✅     | Given a preview of a text replacement; when the user declines; then nothing is written.                                                                                              |
| UC-CONFLUCO-CONFLUENCE-003-S03 | P0       | ✅     | Given the published page was changed after the preview; when the user confirms it; then Confluco refuses to write and asks for a new preview.                                        |
