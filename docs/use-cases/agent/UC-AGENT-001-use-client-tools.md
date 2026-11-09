# UC-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with information or actions the extension has, such as which Notion page is open. The extension offers the AI a set of tools. Instead of guessing, the AI asks the extension to run one; the extension runs it and sends back the result, and the AI uses that result to answer. The AI may use several tools, one after another, before it answers.

Each question gets a bounded number of steps, so a model that keeps calling tools cannot run on forever, and the user can stop the agent at any time.

The user can always see what the agent did: each tool it used, with what input, and whether it worked, in the order it happened within the reply.

Key constraints:

- Tools run in the extension, never on the server. The server only carries the AI's request to run a tool and the result back.
- Tool definitions, tool requests, and tool results are part of the conversation: the same size limits, quota, and usage records apply, and none of their content is kept by the service.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S01 | P0 | ✅ | Given a signed-in user and a tool the extension offers; when they ask something that needs that tool; then the reply asks the extension to run it, with its arguments, instead of answering. |
| UC-AGENT-001-S02 | P0 | ✅ | Given the result of a tool the extension ran; when it is sent back with the conversation; then the AI answers using it. |
| UC-AGENT-001-S03 | P0 | ✅ | Given a signed-in user who uses tools; when they ask the AI; then nothing in the tool definitions, tool requests, or tool results is kept by the service. |
| UC-AGENT-001-S04 | P0 | ✅ | Given a question that needs a tool; when the user asks it in the side panel; then the tool runs in the extension and the answer uses its result. |
| UC-AGENT-001-S05 | P1 | ✅ | Given a model that keeps calling tools; when the question reaches its step limit; then the agent stops without running more tools and tells the user, and the next question still works. |
| UC-AGENT-001-S07 | P1 | ✅ | Given the agent working on a question; when the user stops it; then the model call and any running tool stop, and the stopped question is left out of the conversation. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S06 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks which page they are on; then the agent looks it up and answers with the page's title. |
| UC-AGENT-001-S08 | P1 | 🚧 | Given the agent used a tool to answer; when the user looks at the reply; then it shows which tool ran, with what input, whether it worked, and, on request, what it returned. |
