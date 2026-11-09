# UC-NOTION-005: Browse the workspace

## Behavior

A signed-in user asks the AI how their Notion workspace is organized: "what projects do I have?", "what's under this page?", "where does the roadmap live?". The AI lists pages and databases the way Notion's sidebar shows them: the top level of the open page's workspace, by section (private pages, pages shared with the user, the workspace's pages, each teamspace), or the pages and databases under a page, a few levels deep if asked. It gets titles and a way to open each one, never their content; reading a page is UC-NOTION-001.

A large workspace is listed only up to a limit, and the AI is told when the list was cut off, so it can list a part of it instead. As with reading, the listing runs as the user's own Notion account, so it shows only pages that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-005-S01 | P0 | ✅ | Given a workspace with private, shared, workspace, and teamspace pages; when the AI lists the top level; then it gets each section's pages and databases with their titles and a way to open them, and no page content. |
| UC-NOTION-005-S02 | P1 | ✅ | Given a page with pages nested under it, some inside columns; when the AI lists it two levels deep; then it gets those two levels and nothing deeper. |
| UC-NOTION-005-S03 | P1 | ✅ | Given more pages than one list shows; when the AI lists them; then it gets the first ones and is told the list was cut off. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-005-S04 | P0 | ✅ | Given the side panel open on a page with pages under it; when the user asks what is under it; then the agent lists them without reading their content. |
