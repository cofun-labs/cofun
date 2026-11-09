# UC-NOTION-007: Create a page

## Behavior

A signed-in user asks the AI to make a new Notion page: draft a document from their notes, file meeting notes, or turn a section into a page of its own. The AI chooses the page's title and content, and where it goes: at the end of the open page, or of another page it names. (A new row in a database is UC-NOTION-008.) The page is created right away, with all its content at once, and the side panel shows its title, where it went, and its content. The AI is told the new page's id and link, so it can read or edit it next.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-007-S06 | P0 | ✅ | Given the open page; when the AI creates a page with content; then it exists at the end of the open page, with that content, without the user being asked first. |
| UC-NOTION-007-S02 | P1 | ✅ | Given another page named as the parent; when the AI creates a page; then it is created there, and the open page is unchanged. |
| UC-NOTION-007-S05 | P1 | ✅ | Given a piece of a page as the parent; when the AI tries to create a page there; then nothing is created and it is told why. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-007-S07 | P0 | 🚧 | Given the side panel open on a Notion page; when the user asks to turn a section into its own child page; then the new page appears under the open page with that content, without the user being asked. |
