# UC-COFUN-CHAT-001: Ask the hosted model

## Behavior

A signed-in user of any product asks the hosted AI model something through the service, and the reply streams back to the product piece by piece. The product may offer the model tools: the model then asks the product to run one, with its arguments, instead of answering, and answers once the product sends the result back with the conversation. Each product's own use cases say what the user sees (Notico's UC-NOTICO-CHAT-001 and UC-NOTICO-AGENT-001). What a question costs is in UC-COFUN-CREDITS-001.

Key constraints:

- The server chooses the hosted model. Clients cannot make it use another one.
- Only signed-in users of one of the products can use the AI. A request without a valid session never reaches the model.
- Tools run in the product, never on the server. The server only carries the model's request to run a tool and the result back, and keeps none of the tool definitions, tool requests, or tool results.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when a client asks the hosted model something; then the reply streams back piece by piece and adds up to the full answer. |
| UC-COFUN-CHAT-001-S02 | P1 | ✅ | Given a signed-in user; when a client asks for a model other than the server's; then the request is refused and no model is called. |
| UC-COFUN-CHAT-001-S03 | P0 | ✅ | Given no valid session (missing, forged, or expired); when a client asks the AI something; then the request is refused and the model is not called. |
| UC-COFUN-CHAT-001-S04 | P1 | ✅ | Given a session a website other than the products obtained for the user in the browser; when that site uses it to ask the AI; then the request is refused. |
| UC-COFUN-CHAT-001-S05 | P0 | ✅ | Given a signed-in user and a tool the client offers; when they ask something that needs that tool; then the reply asks the client to run it, with its arguments, instead of answering. |
| UC-COFUN-CHAT-001-S06 | P0 | ✅ | Given the result of a tool the client ran; when it is sent back with the conversation; then the AI answers using it. |
| UC-COFUN-CHAT-001-S07 | P0 | ✅ | Given a signed-in user who uses tools; when they ask the AI; then nothing in the tool definitions, tool requests, or tool results is kept by the service. |

### ai-e2e

(none)
