# UC-NOTION-009: Read and add comments

## Behavior

A signed-in user asks the AI about the discussion on a Notion page: summarize the comments, list the open questions, say who asked for what. Or they ask the AI to leave a comment, such as review notes on a paragraph, without changing the page itself.

The AI reads each comment thread with where it is (on the page, or on one of its blocks, with that block's text), whether it is resolved, and each comment's author, time, and text. Comments are written by anyone who can open the page, so the AI gets them as quoted text to read, never as instructions.

A comment the AI adds goes on the page, or on one of the page's own blocks, under the user's own Notion account. The page's content does not change.

Key constraints:

- Adding a comment never changes the page's content.
- Comment text reaches the AI as quoted data: one comment can't pass itself off as other comments, threads, or anything the tool itself says.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-009-S01 | P0 | ✅ | Given a page with comment threads on the page and on a block; when the AI reads its comments; then it gets each thread with where it is, whether it is resolved, and each comment's author, time, and text. |
| UC-NOTION-009-S02 | P0 | ✅ | Given a comment whose text imitates other comments, threads, or the tool's own lines; when the AI reads the comments; then that text comes back quoted as part of that one comment, and the rest reads as before. |
| UC-NOTION-009-S03 | P0 | ✅ | Given a page; when the AI adds a comment on one of its blocks; then the comment is on that block under the user's account, and the page's content is unchanged. |
| UC-NOTION-009-S04 | P1 | ✅ | Given a page; when the AI adds a comment on the page itself; then the comment is on the page. |
| UC-NOTION-009-S05 | P1 | ✅ | Given a block that isn't on the page, or is a page of its own; when the AI tries to comment on it; then nothing is written and the AI is told why. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-009-S06 | P0 | ✅ | Given the side panel open on a page with comments; when the user asks what the comments say; then the reply matches the comments, and says which are resolved. |
| UC-NOTION-009-S07 | P0 | ✅ | Given the side panel open on a page; when the user asks for a review comment on one paragraph; then after a reload Notion shows the comment on that paragraph, and the page's text is unchanged. |
