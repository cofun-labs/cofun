# UC-CONFLUCO-SESSION-001: Keep sessions and pick up where you left off

## Behavior

Each conversation in the side panel is a session. Each question is sent with the conversation so far, so the user can ask a follow-up; a signed-in user can start a new session at any time, and opening the side panel starts one. Past sessions are kept in a list the user can search, reopen, and delete, each titled in a few words, in the question's language, once its first reply is in, by the model the user is asking with (the hosted one spends credits on it, their own uses their key). Reopening a session shows the whole conversation, tools included, and the next question continues it as if it had never been closed.

Sessions are kept on the user's device, also after they sign out, and the service never stores them.

Key constraints:

- A session's context stays in that session. A new or different session never sends another session's conversation to the AI.
- Sessions belong to the account that made them. Another account signed in on the same browser cannot see or reopen them.

## Scenarios

### api-test

| ID                          | Priority | Status | Scenario                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-CONFLUCO-SESSION-001-S01 | P0       | ✅     | Given a session with an answered question in which the agent used a tool, still open or saved and reopened; when the user asks a follow-up in it; then the AI gets the earlier conversation, including the tool calls and their results, followed by the new question.                                                                                                                              |
| UC-CONFLUCO-SESSION-001-S06 | P0       | ✅     | Given a session from earlier in which the agent used a tool, and the side panel opened again; when the user reopens that session and asks a follow-up; then the earlier conversation shows with its tool calls, and the reply uses the earlier context.                                                                                                                                             |
| UC-CONFLUCO-SESSION-001-S09 | P0       | ✅     | Given sessions saved by one account; when another account signs in on the same browser; then it sees none of them and cannot reopen them.                                                                                                                                                                                                                                                           |
| UC-CONFLUCO-SESSION-001-S14 | P1       | ✅     | Given a new session; when the first reply has come in; then the model is asked for a short title from the first question and the start of the reply, and the session is listed and headed with that title, which later questions don't change; until it comes, or when the request fails or gives nothing usable, the session goes by its first question, and the chat goes on with no error shown. |

### ai-e2e

(none)
