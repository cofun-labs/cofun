# UC-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with information or actions the extension has, such as which Notion page is open. The extension offers the AI a set of tools. Instead of guessing, the AI asks the extension to run one; the extension runs it and sends back the result, and the AI uses that result to answer.

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

### ai-e2e

(none)
