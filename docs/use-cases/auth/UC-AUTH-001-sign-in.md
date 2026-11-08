# UC-AUTH-001: Sign in to use Copilot

## Behavior

A Notion user signs in once on the web sign-in page, including with Google, and is then signed in inside the side panel without reopening it. Signing out from the side panel signs them out. Sign-in happens on a web page because Chrome side panels can't complete social-login redirects.

Key constraint:

- Only signed-in users of this product can use the AI. A request without a valid session never reaches the model.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AUTH-001-S01 | P0 | verified | Given no valid session (missing, forged, or expired); when a client asks the AI something; then the request is refused and the model is not called. |
| UC-AUTH-001-S02 | P1 | verified | Given a session issued to a site that is not this product; when it is used to ask the AI; then the request is refused. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AUTH-001-S03 | P0 | verified | Given the side panel asks the user to sign in; when they sign in with Google on the page it opens; then the open side panel shows the chat. |
| UC-AUTH-001-S04 | P1 | verified | Given a signed-in user; when they sign out from the side panel; then the side panel asks them to sign in again. |
