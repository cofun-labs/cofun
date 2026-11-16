# UC-NOTICO-NOTION-001: Read a Notion page

## Behavior

A signed-in user asks the AI about a Notion page: the one open next to the side panel, or another page the user or the AI names. The AI reads the page's content in order, with its structure, as the user's own Notion account, and answers from it; child pages and databases appear by name, and a long page is read in parts.

When Notion turns a request away, or fails in a way that isn't understood, nothing is tried again: the question stops and the user is told why. Failures the AI can act on, such as a page the account can't open, are told to the AI instead. This holds for everything the AI does in Notion.

Key constraints:

- Only pages the user's signed-in Notion account can open are read.
- Nothing on the page is silently left out: content the AI can't be shown is marked as being there.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-001-S01 | P0 | ✅ | Given a page with common kinds of content; when the AI reads it; then it gets the content in page order, with its structure, and each piece marked so it can be referred to. |
| UC-NOTICO-NOTION-001-S02 | P1 | ✅ | Given a page with content that can't be shown; when the AI reads it; then that content is marked as being there, and nothing after it is lost. |
| UC-NOTICO-NOTION-001-S03 | P1 | ✅ | Given a page too long for one read; when the AI reads it; then it gets the first part, is told there is more, and can read the rest part by part, each from the page as it is when that part is read, and is told that parts may overlap or leave a gap if the page changed in between. |
| UC-NOTICO-NOTION-001-S04 | P1 | ✅ | Given a database row; when the AI reads it; then the row's properties come with its content. |
| UC-NOTICO-NOTION-001-S05 | P1 | ✅ | Given a page with child pages and databases; when the AI reads it; then they appear by name with a way to open them, and their content is not included. |
| UC-NOTICO-NOTION-001-S06 | P0 | ✅ | Given a page the user's Notion account can't open; when the AI tries to read it; then it is told the page can't be read and gets none of its content. |
| UC-NOTICO-NOTION-001-S08 | P1 | ✅ | Given Notion turns a request away because it is limiting requests; when the AI reads a page; then nothing is tried again, nothing more is sent to Notion, the question stops, and the user is told to wait before asking again. |
| UC-NOTICO-NOTION-001-S09 | P1 | ✅ | Given a page with closed toggles; when the AI reads it; then it gets what is inside them too, nested toggles included. |
| UC-NOTICO-NOTION-001-S11 | P1 | ✅ | Given Notion fails a request in a way that isn't understood (a server error, an error it doesn't explain, an answer that isn't what Notion sends); when the AI reads a page; then nothing is tried again, the question stops, and the user is told what went wrong. |
| UC-NOTICO-NOTION-001-S13 | P1 | ✅ | Given Notion turned a request away and said how long to wait; when the user asks again in the same side panel before that wait is over; then nothing is sent to Notion, the question stops, and the user is told how long to wait. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-001-S07 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks for a summary; then the agent reads the page and the summary matches its content. |
| UC-NOTICO-NOTION-001-S10 | P1 | ✅ | Given the side panel open on a page whose toggles are closed; when the user asks about what is inside one; then the agent answers from the toggle's content. |
