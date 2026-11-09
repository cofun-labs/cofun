# UC-NOTION-008: Change properties and rows

## Behavior

A signed-in user asks the AI to keep a page's or a database's fields up to date: mark tasks done, set due dates or owners' notes from what a page says, rename a page or give it an icon, or add rows to a tracker. The AI proposes the changes, several pages in one go ("mark these five tasks done" is one approval), with each new value and, where the AI has seen it, the old one. Values are given as the database shows them, and must fit the property: an option the property doesn't have, or a date that isn't one, is refused before anything changes, and the AI is told why. The user approves, and then every change is made at once, or none is. A new row goes into the database with its title, its properties, and any content.

Key constraints:

- Nothing changes until the user approves.
- A value that doesn't fit its property is never written, and nothing else in the same request is either.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-008-S01 | P0 | ✅ | Given rows in a database; when the AI sets properties on several of them and the user approves; then exactly those rows change, in one change. |
| UC-NOTION-008-S02 | P0 | ✅ | Given a value that doesn't fit its property (an unknown option, a date that isn't one, a property that can't be set); when the AI tries to set it; then nothing is written and the AI is told why. |
| UC-NOTION-008-S03 | P1 | ✅ | Given a database; when the AI adds a row with properties and content and the user approves; then the row is in the database with those values. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-008-S04 | P0 | ✅ | Given the side panel open on a task database; when the user asks to mark the overdue tasks done and approves; then those rows show done after a reload, and the others are unchanged. |
