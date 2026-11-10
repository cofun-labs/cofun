# UC-NOTION-011: Mention people

## Behavior

A signed-in user asks the AI to write something that names a workspace member, such as a task for someone ("@Kim to follow up") in a note, a new page, or a comment. The AI mentions that member by name, and Notion shows a real mention of that person, as if the user had picked them from Notion's own @ menu.

The AI finds members by name among the people the user can see in the workspace. Mentions read back the way they are written, so a block the AI reads and writes back keeps its mentions.

Key constraint:

- A mention always names exactly one member. A name that matches no member, or more than one, is refused before anything is written, and the AI is told which members it could mean.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-011-S01 | P0 | 🚧 | Given a workspace with a member named Kim Lee; when the AI writes a line on a page that mentions Kim Lee; then the page has a mention of that member, and reading the page shows it the way the AI wrote it. |
| UC-NOTION-011-S02 | P1 | 🚧 | Given a page with a mention of a member; when the AI changes other text in that block; then the block still mentions that member. |
| UC-NOTION-011-S03 | P1 | 🚧 | Given a workspace with a member named Kim Lee; when the AI creates a page or adds a comment that mentions Kim Lee; then the new page or comment mentions that member. |
| UC-NOTION-011-S04 | P0 | 🚧 | Given no member with the name the AI wrote; when it writes the mention; then nothing is written, and the AI is told the members with a similar name. |
| UC-NOTION-011-S05 | P0 | 🚧 | Given two members with the same name; when the AI mentions that name; then nothing is written, and the AI is told the name is ambiguous. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-011-S06 | P1 | 🚧 | Given the side panel open on a page; when the user asks the AI to add a to-do for themselves by name; then after a reload Notion shows the to-do with a mention of the user. |
