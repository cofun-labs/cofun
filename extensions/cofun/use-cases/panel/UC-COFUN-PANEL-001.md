# UC-COFUN-PANEL-001: Use the browser copilot

## Behavior

Cofun opens a side panel for asking about browser tabs and the public web. Sign-in and hosted credits come from the shared Cofun service. The assistant can read allowed tabs and public pages, and search the web. It does not offer workspace actions.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-PANEL-001-S01 | P0 | ✅ | Given a signed-out user with Cofun open; when they press Sign in; then the shared sign-in page opens in a browser tab. |
| UC-COFUN-PANEL-001-S02 | P0 | ✅ | Given a signed-in user with Cofun open; when they ask about a public web page; then they see the answer based on that page, and can see their hosted balance from the account menu. |

### ai-e2e

(none)
