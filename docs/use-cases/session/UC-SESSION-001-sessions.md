# UC-SESSION-001: Keep sessions and pick up where you left off

## Behavior

Each conversation in the side panel is a session. A signed-in user can start a new session at any time, and opening the side panel starts one. Past sessions are kept in a list, most recently used first, each titled with its first question and showing the Notion page it started on. The user can search the list by title, narrow it to sessions started on one Notion page, and delete sessions they no longer want.

Reopening a session shows the whole conversation, including the tools the agent used and what they returned, and the next question continues it: the AI has the earlier conversation as context, as if the session had never been closed. Switching to another session while a reply is still coming stops that reply first, so it never lands in the wrong session.

Sessions are kept on the user's device and do not follow them to other devices. The service never stores them; it only sees the conversation the AI needs to answer the current question (see UC-AGENT-001 and UC-CHAT-002).

Key constraint:

- A session's context stays in that session. A new or different session never sends another session's conversation to the AI.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-SESSION-001-S01 | P0 | ✅ | Given a saved session in which the agent used a tool; when the user reopens it and asks a follow-up; then the AI gets the earlier conversation, including the tool calls and their results, followed by the new question. |
| UC-SESSION-001-S02 | P1 | ✅ | Given a user with saved sessions; when they ask the AI in a new session; then nothing from the earlier sessions is sent to the AI. |
| UC-SESSION-001-S03 | P1 | ✅ | Given several saved sessions; when the user opens the session list; then it shows them most recently used first, each titled with its first question and with the Notion page it started on. |
| UC-SESSION-001-S04 | P1 | ✅ | Given sessions with different titles started on different Notion pages; when the user searches by title or picks a page; then only the sessions that match are listed. |
| UC-SESSION-001-S05 | P1 | ✅ | Given a saved session; when the user deletes it; then it is no longer listed and cannot be reopened. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-SESSION-001-S06 | P0 | ✅ | Given a session from earlier in which the agent used a tool, and the side panel opened again; when the user reopens that session and asks a follow-up; then the earlier conversation shows with its tool calls, and the reply uses the earlier context. |
| UC-SESSION-001-S07 | P1 | ✅ | Given earlier sessions; when the user opens the side panel; then it starts a new, empty session, and the earlier sessions are in the list. |
| UC-SESSION-001-S08 | P2 | ✅ | Given a reply still coming in; when the user switches to another session; then that reply stops and does not appear in either session. |
