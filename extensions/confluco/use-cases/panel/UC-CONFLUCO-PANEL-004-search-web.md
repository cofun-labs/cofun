# UC-CONFLUCO-PANEL-004: Choose where web searches go

## Behavior

In Settings, a user can switch web searches to DuckDuckGo, free, in a background tab, instead of the service. Switching it on asks Chrome for access to DuckDuckGo; without that access, searches stay with the service.

## Scenarios

### api-test

| ID                        | Priority | Status | Scenario                                                                                                                                                                                                                                                         |
| ------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-PANEL-004-S11 | P1 | ✅ | Given a user switching on DuckDuckGo in Settings; when they decline Chrome's request for access to it; then the switch stays off, and searches go to the service. |

### ai-e2e

(none)
