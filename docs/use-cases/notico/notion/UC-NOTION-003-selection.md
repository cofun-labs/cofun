# UC-NOTION-003: Work on the selection

## Behavior

A signed-in user selects something in their Notion page, text across one or more blocks or whole blocks, and asks the AI about it: "rewrite this", "translate the highlighted paragraph", "explain this". The AI gets what is selected, the selected text and the pieces of the page it covers, each with the reference an edit uses (UC-NOTION-002), so it can work on exactly that part without reading the whole page. Nothing selected is a normal answer, not an error. A text selection may start in the page title or run into a side peek; the AI gets the open page's blocks it covers. When blocks selected on a long page may go on past the part Notion has drawn in the browser, the AI is told some may be missing.

Key constraint:

- What the AI can change from a selection is only what was selected: other pieces of the page still need a read first.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-003-S01 | P0 | ✅ | Given text selected across two blocks, or blocks selected as blocks; when the AI asks for the selection; then it gets the selected text and those blocks, each with its reference. |
| UC-NOTION-003-S02 | P1 | ✅ | Given nothing selected; when the AI asks for the selection; then it is told nothing is selected. |
| UC-NOTION-003-S03 | P0 | ✅ | Given a selected block; when the AI rewrites it and the user agrees; then only that block changes, and blocks outside the selection can't be changed without a read. |
| UC-NOTION-003-S05 | P2 | ✅ | Given blocks selected as blocks that reach the first or last block Notion has drawn of a page that goes on past it; when the AI asks for the selection; then it gets those blocks and is told the selection may go on. |
| UC-NOTION-003-S06 | P2 | ✅ | Given text selected from the page title into its content, or from the page into a side peek; when the AI asks for the selection; then it gets the selected text and the open page's blocks it covers. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-003-S04 | P0 | ✅ | Given a paragraph selected in a Notion page; when the user asks in the side panel to rewrite it and agrees; then only that paragraph changes. |
| UC-NOTION-003-S07 | P1 | ✅ | Given blocks selected as blocks in a Notion page; when the user asks in the side panel to rewrite them and agrees; then only those blocks change. |
