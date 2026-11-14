# UC-NOTICO-NOTION-010: Reorganize pages

## Behavior

A signed-in user asks the AI to tidy up their Notion pages: file a page under another page, make a copy of a page to start from, or clear out pages they no longer need. The AI moves a page to the end of another page, duplicates a page with its content next to the original, or moves pages to Notion's trash. Moving and duplicating happen right away, and the side panel shows which page went where. Trashing asks the user first, every time, showing each page and saying it goes to the trash; pages go to Notion's trash, where the user can restore them, and are never deleted for good. A page can't be moved into itself or into a page inside it. Moving doesn't ask first, even though a moved page is shared like the page it goes into, so it can become visible to people who couldn't see it before: only trashing asks, as the user chose.

Key constraints:

- Pages go to the trash only after the user agrees, and never past it.
- A page is never moved into itself or into one of its own pages.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-010-S01 | P0 | ✅ | Given a page under one page; when the AI moves it to another page; then it is at the end of that page with its content, no longer under the first, without the user being asked. |
| UC-NOTICO-NOTION-010-S02 | P0 | ✅ | Given pages the AI wants to trash; when it asks to; then the user is asked first, shown each page and that it goes to the trash, and only after they agree are the pages in Notion's trash, out of their parents, restorable. |
| UC-NOTICO-NOTION-010-S06 | P1 | ✅ | Given a user who agreed to trash one page; when the AI then trashes another, in the same question or a later one; then the user is asked again, and that page is trashed only once they agree. |
| UC-NOTICO-NOTION-010-S03 | P1 | ✅ | Given a page with content; when the AI duplicates it; then a copy with the same content is next to the original, without the user being asked, and the original is unchanged. |
| UC-NOTICO-NOTION-010-S04 | P1 | ✅ | Given a page; when the AI tries to move it into itself or a page inside it; then nothing moves and the AI is told why. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-010-S05 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks to move one page under another, duplicate it, and trash a third; then the move and copy happen without asking, the panel asks before trashing, and after the user agrees the page is in Notion's trash. |
