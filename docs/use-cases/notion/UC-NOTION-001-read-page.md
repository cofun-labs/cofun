# UC-NOTION-001: Read a Notion page

## Behavior

A signed-in user asks the AI about a Notion page: the one open next to the side panel, or another page the user or the AI names. The AI reads the page's content in order, with its structure (headings, lists, to-dos, toggles, tables, code, and so on), and answers from it: a summary, an answer to a question, a translation, a list of action items. A database row comes with its properties.

Child pages and databases on the page appear by name, and the AI can open them in turn, but their content is not part of the page. Each piece of the page is marked, so the AI can refer to it exactly.

The AI reads as the user's own Notion account: it can read only what that account can open. A long page is read in parts, so one read never crowds out the conversation. When Notion is limiting the account's requests, the AI waits and tries again; if Notion keeps refusing, it stops asking and is told to have the user wait, so the account isn't pushed further.

Key constraints:

- Only pages the user's signed-in Notion account can open are read.
- Nothing on the page is silently left out: content the AI can't be shown is marked as being there.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-001-S01 | P0 | ✅ | Given a page with common kinds of content; when the AI reads it; then it gets the content in page order, with its structure, and each piece marked so it can be referred to. |
| UC-NOTION-001-S02 | P1 | ✅ | Given a page with content that can't be shown; when the AI reads it; then that content is marked as being there, and nothing after it is lost. |
| UC-NOTION-001-S03 | P1 | ✅ | Given a page too long for one read; when the AI reads it; then it gets the first part, is told there is more, and can read the rest part by part. |
| UC-NOTION-001-S04 | P1 | ✅ | Given a database row; when the AI reads it; then the row's properties come with its content. |
| UC-NOTION-001-S05 | P1 | ✅ | Given a page with child pages and databases; when the AI reads it; then they appear by name with a way to open them, and their content is not included. |
| UC-NOTION-001-S06 | P0 | ✅ | Given a page the user's Notion account can't open; when the AI tries to read it; then it is told the page can't be read and gets none of its content. |
| UC-NOTION-001-S08 | P1 | ✅ | Given Notion is limiting the account's requests; when the AI reads a page; then it waits and tries again, and if Notion keeps refusing, it stops after a few tries and is told to have the user wait. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-001-S07 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks for a summary; then the agent reads the page and the summary matches its content. |
