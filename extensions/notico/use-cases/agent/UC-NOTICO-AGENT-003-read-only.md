# UC-NOTICO-AGENT-003: Keep the agent from changing anything

## Behavior

A signed-in user chooses from the message box whether the agent may change their Notion workspace. In Edit, the default, it changes pages as UC-NOTICO-AGENT-001 describes; in Read only it can only look things up, and a question that needs a change is answered with why it can't and how to switch back. A switch applies from the next question, and the mode is kept on this device for the account that chose it.

Key constraint:

- In Read only, the agent is never offered a tool that changes the user's data, so no question asked in it can change anything, whatever the question, a page, or the model says.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-003-S01 | P0 | ✅ | Given a user who switched to Read only; when they ask for a change to the open page; then the AI is offered only tools that read, is told the question is in Read only and how the user can switch, and nothing in Notion changes, even when the model asks for a change anyway. |
| UC-NOTICO-AGENT-003-S02 | P1 | ✅ | Given a user who has not chosen a mode; when they ask for a change; then the agent may make it, as in Edit. |
| UC-NOTICO-AGENT-003-S03 | P1 | ✅ | Given a question running in Read only; when the user switches to Edit before it ends; then that question still can't change anything, and the next one, with the conversation so far, can. |
| UC-NOTICO-AGENT-003-S04 | P1 | ✅ | Given a user who switched to Read only; when they open the side panel again later; then it is still Read only, and another account signed in on the same browser starts in Edit. |
| UC-NOTICO-AGENT-003-S05 | P1 | ✅ | Given a question asked in Read only and one asked in Edit; when the session is reopened later; then the first says it was asked in Read only, and the second says nothing about a mode. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-003-S06 | P1 | ✅ | Given the side panel open on a Notion page in Read only; when the user asks to change the page, then switches to Edit and asks again; then the first reply says it can't make changes in Read only and how to switch, with the page unchanged, and the second makes the change. |
