# UC-AGENT-CHAT-001: Continue long conversations

## Behavior

A user can keep asking questions and reading with tools as a conversation grows. When its context reaches the request budget, the agent summarizes earlier work and continues with the current question and recent context. The saved chat keeps the original conversation and reuses its summary when reopened.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-CHAT-001-S01 | P1 | ✅ | Given the tools in one question return enough to exceed the model request budget; when the agent continues the question; then it summarizes earlier work and answers the original question without repeating the tools. |
| UC-AGENT-CHAT-001-S02 | P1 | ✅ | Given a saved chat that was compacted; when the user opens it again and asks a follow-up; then the chat still holds the original messages and the next request uses the saved summary. |
| UC-AGENT-CHAT-001-S03 | P1 | ✅ | Given a chat that fit the larger model but needs multiple summary requests on a smaller model; when the user switches and asks again; then the smaller model summarizes the older history in order and answers the new question. |
| UC-AGENT-CHAT-001-S04 | P1 | ✅ | Given a model with a context window below 200,000 tokens; when the user asks a question with it; then the chat explains the minimum window without sending the question. |
