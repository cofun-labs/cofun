# UC-NOTICO-NOTION-013: Undo what a question changed

## Behavior

The AI changes Notion without asking first (UC-NOTICO-NOTION-002, UC-NOTICO-NOTION-007, UC-NOTICO-NOTION-008), so a signed-in user can undo what one question changed, from the reply's Undo or by asking the AI to undo it. Undoing puts back the content the question inserted, replaced, or deleted, moves the pages, rows, copies, and databases it created to Notion's trash, and sets back the titles, icons, and row values it changed. The user sees what will be undone and agrees once. What it can't undo (comments, moved or trashed pages, a database's properties) is named, not undone. An undo is saved with the chat, so a chat continued later can still be undone.

Key constraints:

- An undo never overwrites what changed after the question: if anything it would put back was changed since, by the user or a later question, nothing is undone, and the user is pointed to Notion's page history.
- An undo is all or nothing, sent once: when Notion doesn't say whether it was saved, it is not tried again, and the user is told to check the pages.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-013-S01 | P0 | ✅ | Given a question that inserted, replaced, and deleted pieces of a page; when the user undoes it from its reply and agrees; then the page has its content as before the question, and the reply says it was undone. |
| UC-NOTICO-NOTION-013-S02 | P0 | ✅ | Given a question that created a page and a database row and changed titles, icons, and row values; when the user undoes it; then the page and the row are in Notion's trash, and the titles, icons, and values are as before. |
| UC-NOTICO-NOTION-013-S03 | P0 | ✅ | Given a question whose changes were changed again since, by the user or a later question, or can't be read in the current tab; when the user undoes it; then nothing changes, and the user is told which page changed (and pointed to Notion's page history) or can't be read. |
| UC-NOTICO-NOTION-013-S04 | P1 | ✅ | Given the user asks the AI to undo its last change; then the AI shows what the latest question that changed Notion did and asks once, and on yes undoes it; on no nothing changes. |
| UC-NOTICO-NOTION-013-S05 | P1 | ✅ | Given a question that also added a comment or moved a page; when the user undoes it; then what will be undone names what won't be, and the rest is undone. |
| UC-NOTICO-NOTION-013-S06 | P1 | ✅ | Given Notion doesn't say whether an undo was saved; then it is not tried again, and the user is told it may or may not have been undone and to check the pages. |
| UC-NOTICO-NOTION-013-S07 | P1 | ✅ | Given a saved chat whose question changed a page; when the user opens the chat again and undoes it; then the page is as before the question, and the chat keeps it undone. |
| UC-NOTICO-NOTION-013-S08 | P2 | ✅ | Given the user undid a question from its reply; when they ask the next question; then the AI is told what was undone, and reads the page again before changing it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-013-S09 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks for an edit and then undoes it from the reply; then the page shows its content as before the question after a reload. |
