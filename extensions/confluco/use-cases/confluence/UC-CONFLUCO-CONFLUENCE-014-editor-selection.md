# UC-CONFLUCO-CONFLUENCE-014: Use selected editor text in chat

## Behavior

A user can select text in a connected self-managed Confluence editor and attach that selection to a question. They can review or remove the excerpt before sending. The assistant receives the selected text as context for the question. Capturing it does not change the page or its draft.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-014-S01 | P0 | ✅ | Given text selected in the connected editor; when the user attaches it and sends a question; then the assistant receives that excerpt and the question. |
| UC-CONFLUCO-CONFLUENCE-014-S02 | P0 | ✅ | Given an empty selection or a tab outside a supported connected editor; when the user asks to attach a selection; then Confluco explains how to select text and adds no context. |
| UC-CONFLUCO-CONFLUENCE-014-S03 | P0 | ✅ | Given a captured selection; when the user removes it or changes the active editor before sending; then Confluco excludes that selection from the question. |
| UC-CONFLUCO-CONFLUENCE-014-S05 | P0 | ✅ | Given a pending editor selection and a selected local file; when the user sends an attachment action; then the separate upload question excludes the editor text and the draft selection remains available. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-014-S04 | P0 | ✅ | Given a disposable Confluence page in the editor; when the user selects one of two synthetic phrases and attaches it to a question; then the assistant can use the selected phrase while leaving the editor intact. |
