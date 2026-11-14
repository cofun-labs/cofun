# UC-NOTICO-NOTION-012: Create and change databases

## Behavior

A signed-in user asks the AI to set up a database from a description, such as a task tracker or a content calendar, or to change the properties of one they have: add a property, rename one, or add, rename, or remove the options of a select. The AI creates the database as a page at the end of a page it names, with a title column and the properties and options it chose, and changes an existing database's properties and options; both happen right away, and the side panel shows what was created or changed. Renaming an option renames it in every row that has it. (Adding and changing rows is UC-NOTICO-NOTION-008.)

Removing a property or an option takes its values away from every row, so the AI removes one only when the user asked to remove exactly that property or option, and the side panel says plainly that its values go with it. A change that would lose values in another way is refused before anything changes, and the AI is told why: a property can't change its type, the title column can't be removed, two properties or two options of one property can't end up with the same name, and an option can't be renamed when the AI can't reach every row that has it.

Key constraint:

- Values in a database are lost only when the user asked to remove exactly the property or option holding them; every other change keeps every row's values, or is not made at all.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-012-S01 | P0 | ✅ | Given a page; when the AI creates a database with properties and options; then a database with that title, a title column, and those properties and options is at the end of the page, without the user being asked first. |
| UC-NOTICO-NOTION-012-S02 | P0 | ✅ | Given a database with rows; when the AI adds a property, renames a property, and adds options, in one change; then the database has them, and every row keeps its values. |
| UC-NOTICO-NOTION-012-S03 | P1 | ✅ | Given rows that have an option; when the AI renames the option; then those rows show the new name, and the other rows are unchanged. |
| UC-NOTICO-NOTION-012-S04 | P0 | ✅ | Given a change that would lose values another way (the title column removed, two properties or options with one name, an option renamed when not every row can be read); when the AI tries it; then nothing changes and the AI is told why. |
| UC-NOTICO-NOTION-012-S05 | P1 | ✅ | Given a property and an option the user asked to remove; when the AI removes them; then they are gone from the database, and the side panel said their values go with them. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-012-S06 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks to set up a task tracker with a status, a due date, and tags; then a database with those properties appears at the end of the page, without the user being asked. |
| UC-NOTICO-NOTION-012-S07 | P1 | ✅ | Given the side panel open on a database with rows; when the user asks to rename a property, add an option, and remove a property by name; then after a reload the database shows those changes, the rows keep their other values, and the reply or the side panel says the removed property's values are gone. |
