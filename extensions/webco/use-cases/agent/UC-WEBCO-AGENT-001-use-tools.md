# UC-WEBCO-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with what the extension has, such as what a web page says. The AI asks the extension to run tools, one after another if needed, and answers from their results.

The user can stop the agent at any time, and a question gets a bounded number of steps and of failed tool calls. However a question ends, answered, failed, or stopped, the tools it used stay in the conversation for the next one.

Key constraints:

- Tools run in the extension, never on the server. The server only carries the AI's request to run a tool and the result back.
- A question that ends before any tool ran leaves nothing in the conversation: the next question is asked as if it had not been.
- These are rules of the agent loop every extension shares (`@cofun/agent`). How an extension asks the user before a tool runs is the extension's own: Webco's asks before it reads a site (UC-WEBCO-PANEL-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-WEBCO-AGENT-001-S01 | P0 | ✅ | Given a question that needs a tool; when the user asks it in the side panel; then the tool runs in the extension and the answer uses its result. |
| UC-WEBCO-AGENT-001-S02 | P1 | ✅ | Given a model that keeps calling tools; when the question reaches its step limit; then the agent stops without running more tools and tells the user, and the next question still works. |
| UC-WEBCO-AGENT-001-S03 | P2 | ✅ | Given a model that keeps calling a tool that fails; when 10 of the question's tool calls have failed; then the question stops without running more tools and tells the user why, a call the user declined does not count, and the next question works. |
| UC-WEBCO-AGENT-001-S04 | P1 | ✅ | Given the agent working on a question; when the user stops it; then the model call and any running tool stop, and the conversation keeps the tools the agent used so far and how each ended, but not the unfinished reply or tools it had not reached yet. |
| UC-WEBCO-AGENT-001-S05 | P1 | ✅ | Given a question that fails or is stopped; when the user asks the next question; then the AI is given the tools the failed question used and their results, and a question that used no tool is left out of the conversation. |
