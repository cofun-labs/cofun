# UC-NOTION-006: Read a database

## Behavior

A signed-in user asks the AI about a Notion database: "which tasks are overdue?", "what's in progress?", "summarize this tracker". The AI reads the database (the one open, or one it names) as a table: its properties, with their names and kinds, and each row's values, with a way to open the row (UC-NOTION-001). It can keep only the rows whose values match some conditions, and order them by a property; to judge dates like "overdue", it is told today's date.

A big database is read in parts, and the AI is told when it holds more rows than one read covers. As with reading pages, it reads as the user's own Notion account, so it sees only rows that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-006-S01 | P0 | ✅ | Given a database with rows; when the AI reads it; then it gets the database's properties and every row's values, each row with a way to open it. |
| UC-NOTION-006-S02 | P0 | ✅ | Given conditions on the rows' values and an order; when the AI reads the database with them; then it gets only the rows that match every condition, in that order. |
| UC-NOTION-006-S03 | P1 | ✅ | Given more rows than one result shows; when the AI reads the database; then it gets the first ones, is told there are more, and can read the rest part by part. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-006-S04 | P0 | ✅ | Given a task database open in Notion; when the user asks which tasks are overdue; then the agent answers with exactly those tasks. |
