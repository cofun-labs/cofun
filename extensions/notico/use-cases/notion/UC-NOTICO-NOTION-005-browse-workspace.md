# UC-NOTICO-NOTION-005: Browse the workspace

## Behavior

A signed-in user asks the AI how their Notion workspace is organized: "what projects do I have?", "what's under this page?". The AI lists pages and databases the way Notion's sidebar shows them: the workspace's top level, by section and teamspace, or the pages under a section or a page, a few levels deep if asked. It gets titles and a way to open each one, never their content. A large list is cut off at a limit, and the AI is told how to list the rest. The listing runs as the user's own Notion account, so it shows only pages that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-005-S01 | P0 | ✅ | Given a workspace with private and shared pages; when the AI lists the top level; then it gets each section's pages and databases with their titles and a way to open them, each page once, and no page content. |
| UC-NOTICO-NOTION-005-S02 | P1 | ✅ | Given a page with pages nested under it, some inside columns; when the AI lists it two levels deep; then it gets those two levels and nothing deeper. |
| UC-NOTICO-NOTION-005-S03 | P1 | ✅ | Given a page or a top-level section with more pages than one list shows; when the AI lists them; then it gets the first ones, is told the list was cut off, and can ask for the next ones, picking up where the list was cut off. |
| UC-NOTICO-NOTION-005-S05 | P0 | ✅ | Given a workspace with teamspaces, some joined by the user and one of them archived; when the AI lists the top level; then it gets each joined teamspace that isn't archived, in the order Notion gives them, with its pages under its name. |
| UC-NOTICO-NOTION-005-S09 | P1 | ✅ | Given a workspace with many teamspaces; when the AI lists its top level; then it gets every section's pages with a request or two to Notion, not one per section, and asking for more than one level without naming a section or page is refused before Notion is asked. |
| UC-NOTICO-NOTION-005-S08 | P1 | ✅ | Given a list that fills up before the asked depth; when the AI lists it; then it is told that what is under the last pages shown wasn't looked into, and not that pages were cut off. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-005-S04 | P0 | ✅ | Given the side panel open on a page with pages under it; when the user asks what is under it; then the agent lists them without reading their content. |
| UC-NOTICO-NOTION-005-S07 | P1 | ✅ | Given the side panel open in a workspace with a teamspace the user joined; when the user asks what teamspaces they have; then the agent names the teamspace and the pages in it. |
