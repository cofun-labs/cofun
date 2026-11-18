# UC-CONFLUCO-CONFLUENCE-004: Browse Confluence spaces and page trees

## Behavior

On a connected Confluence instance, the user can browse the spaces they can see, open a space's homepage, and find a published page's ancestors and direct children. Each page reference identifies its originating instance, so a reference from a different instance cannot select an unrelated page. On Cloud the page tree reports published pages and folders from the hierarchy, in the site's order, and the user can browse into a folder to find the pages under it. A folder reference is used only to browse the tree, never as a page.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-004-S01 | P0 | ✅ | Given a connected instance with visible spaces; when the user browses spaces and selects one; then the assistant can provide its name, link, and homepage. |
| UC-CONFLUCO-CONFLUENCE-004-S02 | P0 | ✅ | Given a visible published page with an ancestor and a child; when the user asks where it sits in the space; then the assistant can identify the page, its ancestors, and its direct children with links. |
| UC-CONFLUCO-CONFLUENCE-004-S03 | P0 | ✅ | Given a page reference from another instance or a page the user cannot access; when the user asks about its hierarchy; then no information about an unrelated or inaccessible page is returned. |
| UC-CONFLUCO-CONFLUENCE-004-S04 | P1 | ✅ | Given a Cloud page whose ancestors and children include a folder; when the user asks where the page sits and what is in the folder; then the assistant can identify the folder among the ancestors and children and list the published pages directly under it. |

### ai-e2e

(none)
