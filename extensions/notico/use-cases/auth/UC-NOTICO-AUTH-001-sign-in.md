# UC-NOTICO-AUTH-001: Sign in to use Notico

## Behavior

A Notion user signs in once on the web sign-in page, including with Google, and is then signed in inside the side panel without reopening it. Signing out from the side panel signs them out. Notico uses the sign-in only to know who the user is: the side panel shows which account is signed in and lets the user sign out, and offers nothing to change the account. Only signed-in users can use the AI; the service refuses anyone else (UC-COFUN-CHAT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AUTH-001-S04 | P1 | ✅ | Given a signed-in user; when they sign out from the side panel; then the side panel asks them to sign in again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AUTH-001-S03 | P0 | ✅ | Given the side panel asks the user to sign in; when they sign in with Google on the page it opens; then the open side panel shows the chat. |
