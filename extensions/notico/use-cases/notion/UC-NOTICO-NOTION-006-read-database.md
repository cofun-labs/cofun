# UC-NOTICO-NOTION-006: Read a database

## Behavior

A signed-in user asks the AI about a Notion database: "which tasks are overdue?", "what's in progress?", "summarize this tracker". The AI reads the database (the one open, or one it names) as a table: its properties, with their names and kinds, and each row's values, with a way to open the row (UC-NOTICO-NOTION-001). It can keep only the rows whose values match some conditions, and order them by a property; to judge dates like "overdue", it is told today's date.

Values read as Notion shows them, and conditions compare against that: a status left unset shows the database's default status, and a relation shows the titles of the pages it links to (those the account can't open stay unnamed).

A big database is read in parts, and the AI is told when it holds more rows than one read covers; when it asked for an order, the rows read are the first ones in that order. As with reading pages, it reads as the user's own Notion account, so it sees only rows that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-006-S01 | P0 | ✅ | Given a database with rows; when the AI reads it; then it gets the database's properties and every row's values, each row with a way to open it. |
| UC-NOTICO-NOTION-006-S02 | P0 | ✅ | Given conditions on the rows' values and an order; when the AI reads the database with them; then it gets only the rows that match every condition, in that order. |
| UC-NOTICO-NOTION-006-S03 | P1 | ✅ | Given more rows than one result shows; when the AI reads the database; then it gets the first ones, is told there are more, and can read the rest part by part. |
| UC-NOTICO-NOTION-006-S05 | P1 | ✅ | Given more rows than one read covers; when the AI reads the database in an order; then the rows it gets are the first ones in that order, and it is told only part of the database was read. |
| UC-NOTICO-NOTION-006-S06 | P2 | ✅ | Given a row whose status was never set; when the AI reads the database; then the row shows the database's default status, and a condition on that status matches it. |
| UC-NOTICO-NOTION-006-S08 | P2 | ✅ | Given a database with dates; when the AI reads it; then it is told today's date on the user's own clock, to judge dates such as "overdue". |
| UC-NOTICO-NOTION-006-S07 | P2 | ✅ | Given a row related to other pages; when the AI reads the database; then the relation shows those pages' titles, and a condition on a title matches it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-006-S04 | P0 | ✅ | Given a task database open in Notion; when the user asks which tasks are overdue; then the agent answers with exactly those tasks. |
