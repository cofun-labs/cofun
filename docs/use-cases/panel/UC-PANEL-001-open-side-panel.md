# UC-PANEL-001: Open the side panel on Notion

## Behavior

A Notion user opens the AI side panel next to a Notion page from the extension's toolbar icon. The side panel is available only on Notion; on other sites the icon does not open it.

## Scenarios

### api-test

(none)

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-PANEL-001-S01 | P0 | verified | Given a Notion page in the active tab; when the user clicks the toolbar icon; then the side panel opens next to the page. |
| UC-PANEL-001-S02 | P1 | verified | Given another site in the active tab; when the user clicks the toolbar icon; then no side panel opens. |
