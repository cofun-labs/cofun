# UC-NOTICO-SESSION-001: Keep sessions and pick up where you left off

## Behavior

Each conversation in the side panel is a session. Each question is sent with the conversation so far, so the user can ask a follow-up; a signed-in user can start a new session at any time, and opening the side panel starts one. Past sessions are kept in a list the user can search, reopen, and delete, each titled in a few words, in the question's language, once its first reply is in, by the model the user is asking with (the hosted one spends credits on it, their own uses their key). Reopening a session shows the whole conversation, tools included, and the next question continues it as if it had never been closed.

Sessions are kept on the user's device, also after they sign out, and the service never stores them.

Key constraints:

- A session's context stays in that session. A new or different session never sends another session's conversation to the AI.
- Sessions belong to the account that made them. Another account signed in on the same browser cannot see or reopen them.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-001-S01 | P0 | ✅ | Given a session with an answered question in which the agent used a tool, still open or saved and reopened; when the user asks a follow-up in it; then the AI gets the earlier conversation, including the tool calls and their results, followed by the new question. |
| UC-NOTICO-SESSION-001-S02 | P1 | ✅ | Given a user with saved sessions; when they open the side panel and ask the AI; then it starts a new, empty session, the earlier sessions are in the list, and nothing from them is sent to the AI. |
| UC-NOTICO-SESSION-001-S13 | P1 | ✅ | Given several saved sessions; when the user opens the session list and searches it; then it shows them most recently used first, each with its title and with the Notion page it started on, and a search lists only those whose title contains what was typed, ignoring case. |
| UC-NOTICO-SESSION-001-S14 | P1 | ✅ | Given a new session; when the first reply has come in; then the model is asked for a short title from the first question and the start of the reply, and the session is listed and headed with that title, which later questions don't change; until it comes, or when the request fails or gives nothing usable, the session goes by its first question, and the chat goes on with no error shown. |
| UC-NOTICO-SESSION-001-S05 | P1 | ✅ | Given a saved session; when the user deletes it; then it is no longer listed and cannot be reopened. |
| UC-NOTICO-SESSION-001-S09 | P0 | ✅ | Given sessions saved by one account; when another account signs in on the same browser; then it sees none of them and cannot reopen them. |
| UC-NOTICO-SESSION-001-S20 | P1 | ✅ | Given a user with a saved session; when they sign out and sign back in to the same account; then the session is in the list again, and reopening it shows its conversation. |
| UC-NOTICO-SESSION-001-S10 | P1 | ✅ | Given one session open in two windows; when the user continues it in both; then the session keeps the first window's conversation, the second window's is saved as a separate session, and both are in the list. |
| UC-NOTICO-SESSION-001-S06 | P0 | ✅ | Given a session from earlier in which the agent used a tool, and the side panel opened again; when the user reopens that session and asks a follow-up; then the earlier conversation shows with its tool calls, and the reply uses the earlier context. |
| UC-NOTICO-SESSION-001-S08 | P1 | ✅ | Given a question still being answered; when the user switches to another session or starts a new one; then the question stops, nothing of it shows in or is sent from the session they went to, and the session it was asked in keeps the question with the tools it used, so reopening it shows them and a follow-up there gives them to the AI; a question that had used no tool is not kept, and a session it was the first question of is not listed. |
| UC-NOTICO-SESSION-001-S17 | P1 | ✅ | Given saved sessions, one of which the panel can no longer read; when the user opens the session list, or that session; then the others are listed as usual, the unreadable one is listed as unreadable and can't be opened, nothing of it is sent to the AI, and the user can delete it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
