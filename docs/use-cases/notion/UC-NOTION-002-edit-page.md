# UC-NOTION-002: Edit a Notion page

## Behavior

A signed-in user asks the AI to change a Notion page: rewrite a paragraph, put a summary at the top, turn notes into a to-do list, check off tasks, remove a section. The AI reads the page first (UC-NOTION-001), then proposes the change in terms of the pieces it saw: new content after one of them or at the start or end of the page, a piece replaced with new content, or a piece deleted. One request can make several such changes.

The user sees what will change, piece by piece with the new text, and approves it. Only then is the page changed, all at once or not at all. Rewriting a piece as the same kind of content keeps what is nested under it. Deleting a piece deletes what is nested under it too, so a piece with a child page or database under it, or with nested content the AI wasn't shown, is not deleted.

Key constraints:

- The page changes only after the user approves that change.
- An edit never overwrites what changed after the AI read the page: if a piece it changes, or inserts after, was changed or removed since, nothing is changed and the AI is told to read the page again.
- Only what the edit names changes. Content the AI can't write (child pages, databases, files, and other content it can't show) is never replaced by an edit.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-002-S01 | P0 | ✅ | Given a page the AI has read; when it inserts, replaces, and deletes pieces in one edit and the user approves; then the page has exactly those changes and nothing else. |
| UC-NOTION-002-S02 | P0 | ✅ | Given a piece the user changed after the AI read the page; when the AI edits it or inserts after it; then nothing changes and the AI is told to read the page again. |
| UC-NOTION-002-S03 | P0 | ✅ | Given an edit the AI proposes; when the user declines it; then the page does not change. |
| UC-NOTION-002-S04 | P1 | ✅ | Given an edit that would replace content the AI can't write (a child page, a database, a file); then nothing changes and the AI is told why. |
| UC-NOTION-002-S05 | P1 | ✅ | Given a page the AI has not read; when it tries to edit it; then nothing changes and it is asked to read the page first. |
| UC-NOTION-002-S06 | P1 | ✅ | Given a piece with content nested under it; when the AI rewrites the piece as the same kind of content; then the nested content stays. |
| UC-NOTION-002-S07 | P1 | ✅ | Given an edit Notion refuses; then nothing on the page changes and the AI is told the edit failed. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-002-S08 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks to put a summary at the top; then they see the change to approve, and after approving, the summary is at the top and still there after a reload. |
