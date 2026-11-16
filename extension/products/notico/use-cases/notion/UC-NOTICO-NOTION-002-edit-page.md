# UC-NOTICO-NOTION-002: Edit a Notion page

## Behavior

A signed-in user asks the AI to change a Notion page: rewrite a paragraph, put a summary at the top, turn notes into a to-do list, remove a section. The AI reads the page first (UC-NOTICO-NOTION-001), then inserts, replaces, or deletes the pieces it saw, writing content the way it reads it. The change is made right away, all at once or not at all, and the side panel shows what changed. A piece with a child page, a database, or content the AI wasn't shown nested under it is never deleted.

As with reading, a failure Notion doesn't explain stops the question, and when a change was or may have been made, the user is told to check the page before asking again.

Key constraints:

- An edit never overwrites what changed after the AI read the page: if a piece it changes, or inserts after, was changed or removed since, nothing is changed and the AI is told to read the page again.
- On a long page read in parts (UC-NOTICO-NOTION-001), the AI can change only pieces it was shown in full in one part. A piece too long for one part, shown across several, is never changed: the AI is told it can't edit it.
- Only what the edit names changes. Content the AI can't write (child pages, databases, files, and other content it can't show) is never replaced by an edit.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-002-S09 | P0 | ✅ | Given a page the AI has read; when it inserts, replaces, and deletes pieces in one edit; then the page has exactly those changes and nothing else, without the user being asked first. |
| UC-NOTICO-NOTION-002-S02 | P0 | ✅ | Given a piece the user changed after the AI read the page; when the AI edits it or inserts after it; then nothing changes and the AI is told to read the page again. |
| UC-NOTICO-NOTION-002-S04 | P1 | ✅ | Given an edit that would replace content the AI can't write (a child page, a database, a file); then nothing changes and the AI is told why. |
| UC-NOTICO-NOTION-002-S05 | P1 | ✅ | Given a page the AI has not read; when it tries to edit it; then nothing changes and it is asked to read the page first. |
| UC-NOTICO-NOTION-002-S06 | P1 | ✅ | Given a piece with content nested under it; when the AI rewrites the piece as the same kind of content, or inserts content inside it; then the nested content stays, and what it inserted is nested in that piece, before what it already held. |
| UC-NOTICO-NOTION-002-S11 | P1 | ✅ | Given Notion turns an edit away, because it is limiting requests or with an error it doesn't explain; then nothing on the page changes, the edit is not tried again, the question stops, and the user is told to wait before asking again, or what Notion said. |
| UC-NOTICO-NOTION-002-S12 | P1 | ✅ | Given Notion doesn't say whether an edit was saved (it is too busy to, no reply comes, or a server error); then nothing is tried again, the question stops, and the user is told the edit may or may not have been made and to check the page. |
| UC-NOTICO-NOTION-002-S14 | P1 | ✅ | Given a page the AI has read; when it writes a table, a callout with a list in it, a heading with content under it, and text with colors, equations, and mentions of people and dates; then the page holds them, and reading it again shows them as the AI wrote them. |
| UC-NOTICO-NOTION-002-S16 | P1 | ✅ | Given a table the AI has read; when it rewrites the table with one cell changed and a row added; then that cell changes and the row is added, and the rest of the table stays as it was. |
| UC-NOTICO-NOTION-002-S19 | P0 | ✅ | Given an edit of several changes, one of which can't be made (a piece changed since the AI read the page); when the AI makes it; then none of its changes is made, and the AI is told why. |
| UC-NOTICO-NOTION-002-S20 | P1 | ✅ | Given a long page whose pieces are shown across several parts; when the AI has read every part and edits a piece one part showed in full, and a piece too long for one part; then the first changes, the second doesn't, and the AI is told the second is split across parts and can't be edited. |
| UC-NOTICO-NOTION-002-S13 | P2 | ✅ | Given an edit Notion saved; when Notion then turns away the AI's next request; then the question stops, and the user is told the edit may already have been made and to check the page before asking again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-002-S10 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks to put a summary at the top; then the summary is at the top without the user being asked, the side panel shows what changed, and the summary is still there after a reload. |
