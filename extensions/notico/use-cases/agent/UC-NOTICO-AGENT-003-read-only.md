# UC-NOTICO-AGENT-003: Keep the agent from changing anything

## Behavior

A signed-in user chooses from the message box whether the agent may change their Notion workspace. In Edit, the default, it changes pages as UC-NOTICO-AGENT-001 describes; in Read only it can only look things up, and a question that needs a change is answered with why it can't and how to switch back. A switch applies from the next question, and the mode is kept on this device for the account that chose it.

Key constraint:

- In Read only, a tool that changes the user's data never runs: the agent refuses every call of one, before it is prepared or shown, so no question asked in it can change anything, whatever the question, a page, or the model says. The tools stay offered, so every request starts the same and the model's prompt cache keeps working.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-003-S01 | P0 | ✅ | Given a user who switched to Read only; when they ask for a change to the open page; then the AI is offered the same tools as in Edit, is told the question is in Read only and how the user can switch, and nothing in Notion changes when the model asks for a change anyway: the call shows as not run, and the model is told why. |
| UC-NOTICO-AGENT-003-S02 | P1 | ✅ | Given a user who has not chosen a mode; when they ask for a change; then the agent may make it, as in Edit. |
| UC-NOTICO-AGENT-003-S03 | P1 | ✅ | Given a question running in Read only; when the user switches to Edit before it ends; then that question still can't change anything, and the next one, with the conversation so far, can. |
| UC-NOTICO-AGENT-003-S04 | P1 | ✅ | Given a user who switched to Read only; when they open the side panel again later; then it is still Read only, another account signed in on the same browser starts in Edit, and a reopened session says which of its questions were asked in Read only. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-003-S06 | P1 | ✅ | Given the side panel open on a Notion page in Read only; when the user asks to change the page, then switches to Edit and asks again; then the first reply says it can't make changes in Read only and how to switch, with the page unchanged, and the second makes the change. |
