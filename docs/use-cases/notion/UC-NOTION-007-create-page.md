# UC-NOTION-007: Create a page

## Behavior

A signed-in user asks the AI to make a new Notion page: draft a document from their notes, file meeting notes, or turn a section into a page of its own. The AI proposes the page, its title and content, and where it goes: at the end of the open page, or of another page it names. (A new row in a database is UC-NOTION-008.) The user sees the title, where it goes, and the content, and approves it; only then is the page created, with all its content at once. The AI is told the new page's id and link, so it can read or edit it next.

Key constraint:

- A page is created only after the user approves it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-007-S01 | P0 | ✅ | Given the user approves; when the AI creates a page with content; then it exists at the end of the open page, with that content. |
| UC-NOTION-007-S02 | P1 | ✅ | Given another page named as the parent; when the AI creates a page; then it is created there, and the open page is unchanged. |
| UC-NOTION-007-S05 | P1 | ✅ | Given a piece of a page as the parent; when the AI tries to create a page there; then nothing is created and it is told why. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-007-S04 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks to turn a section into its own child page and approves; then the new page appears under the open page with that content. |
