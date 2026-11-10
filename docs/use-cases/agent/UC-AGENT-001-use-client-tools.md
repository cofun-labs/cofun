# UC-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with information or actions the extension has, such as which Notion page is open. The extension offers the AI a set of tools. Instead of guessing, the AI asks the extension to run one; the extension runs it and sends back the result, and the AI uses that result to answer. The AI may use several tools, one after another, before it answers.

Each question gets a bounded number of steps, so a model that keeps calling tools cannot run on forever, and the user can stop the agent at any time.

A question that fails or is stopped leaves no half-finished exchange behind, but what the agent already did stays: each tool it used, and how that ended (its result, a failure, the user declining it, or the user stopping it), remains part of the conversation, so the AI knows about it in the next question. The unfinished reply, and tools the agent had not reached yet, are left out.

The user can always see what the agent did: each tool it used, with what input, and whether it worked, in the order it happened within the reply.

Key constraints:

- Tools run in the extension, never on the server. The server only carries the AI's request to run a tool and the result back.
- A tool that moves the user's pages to the trash never runs without the user's confirmation, which they are asked for each time; other changes are made right away, and the side panel shows them. If they decline, the tool does not run and the agent goes on without it; if they stop the agent while it waits, the tool does not run and the question ends.
- Tool definitions, tool requests, and tool results are part of the conversation: the same size limits, quota, and usage records apply, and none of their content is kept by the service. Each round trip to the model counts as one request against the daily quota (UC-CHAT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S01 | P0 | ✅ | Given a signed-in user and a tool the extension offers; when they ask something that needs that tool; then the reply asks the extension to run it, with its arguments, instead of answering. |
| UC-AGENT-001-S02 | P0 | ✅ | Given the result of a tool the extension ran; when it is sent back with the conversation; then the AI answers using it. |
| UC-AGENT-001-S03 | P0 | ✅ | Given a signed-in user who uses tools; when they ask the AI; then nothing in the tool definitions, tool requests, or tool results is kept by the service. |
| UC-AGENT-001-S04 | P0 | ✅ | Given a question that needs a tool; when the user asks it in the side panel; then the tool runs in the extension and the answer uses its result. |
| UC-AGENT-001-S05 | P1 | ✅ | Given a model that keeps calling tools; when the question reaches its step limit; then the agent stops without running more tools and tells the user, and the next question still works. |
| UC-AGENT-001-S09 | P0 | ✅ | Given a tool that needs confirmation; when the user declines it; then it does not run, and the agent continues without it. |
| UC-AGENT-001-S10 | P0 | ✅ | Given a tool that needs confirmation; when the user agrees; then it runs and the answer uses its result. |
| UC-AGENT-001-S12 | P1 | ✅ | Given the agent working on a question; when the user stops it; then the model call and any running tool stop, and the conversation keeps the tools the agent used so far and how each ended, including one stopped while it waited for the user's confirmation, but not the unfinished reply or tools it had not reached yet. |
| UC-AGENT-001-S13 | P1 | ✅ | Given a question that fails after the agent used a tool; when the user asks the next question; then the AI is given that tool's request and result. |
| UC-AGENT-001-S14 | P1 | ✅ | Given a question that is stopped or fails before the agent used any tool; when the user asks the next question; then that question is left out of the conversation. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S06 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks which page they are on; then the agent looks it up and answers with the page's title. |
| UC-AGENT-001-S08 | P1 | ✅ | Given the agent used a tool to answer; when the user looks at the reply; then it shows which tool ran, with what input, whether it worked, and, on request, what it returned. |
| UC-AGENT-001-S11 | P1 | ✅ | Given a tool that needs confirmation; when the agent wants to use it; then the side panel asks the user first, showing what the tool will do, and the tool runs only after they agree. |
