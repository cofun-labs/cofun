# UC-NOTION-004: Find and read other pages

## Behavior

A signed-in user asks the AI something another page of their Notion workspace answers: "where did we write about the launch?", "what did the last retro decide?". The AI searches the workspace of the open page by words, as Notion's own search does, and gets the matching pages: each one's title, where it sits in the workspace, when it was last edited, and the text that matched. It can then read any of them (UC-NOTION-001) and answer from what they say, naming the page it used. As with reading, the search runs as the user's own Notion account, so it finds only pages that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-004-S01 | P0 | ✅ | Given pages that match the words the AI searches for; when it searches; then it gets them with their titles, where they are, and the text that matched, each with a way to open it. |
| UC-NOTION-004-S02 | P1 | ✅ | Given no page matches; when the AI searches; then it is told nothing was found. |
| UC-NOTION-004-S03 | P1 | ✅ | Given a page the search found; when the AI opens it; then it reads it as it would the open page. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-004-S04 | P0 | ✅ | Given a page in the workspace about a topic; when the user, on another page, asks a question that page answers; then the agent finds it, reads it, and answers from it. |
