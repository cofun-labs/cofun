# UC-CONFLUCO-AUTH-001: Sign in to use Confluco

## Behavior

A user signs in to Cofun on its web sign-in page. The side panel uses the active account for chat and its credits.

## Scenarios

### api-test

| ID                       | Priority | Status | Scenario                                                                                                                                  |
| ------------------------ | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-AUTH-001-S01 | P0       | ✅     | Given an active Cofun sign-in; when the side panel opens; then the user can ask a question and see their Cofun credits.                   |
| UC-CONFLUCO-AUTH-001-S04 | P0       | ✅     | Given the user is signed in; when they sign out from the side panel; then the panel returns to the sign-in screen and the chat is closed. |

### ai-e2e

(none)
