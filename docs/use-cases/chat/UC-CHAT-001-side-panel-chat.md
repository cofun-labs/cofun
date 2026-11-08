# UC-CHAT-001: Chat from the side panel

**Actor:** Signed-in user
**Goal:** Ask the AI something from the side panel and read the reply as it streams in.

## Rules

- R1: The worker exposes an OpenAI-compatible `POST /v1/chat/completions`.
- R2: The model is chosen by the server. A request may omit `model` or name the server's model; any other model is rejected.
- R3: When an AI Gateway is configured, requests go through it, tagged with the app name and the Clerk user id.
- R4: Invalid requests are rejected before the model is called.

## Scenarios

### UC-CHAT-001-S01: Signed-in user gets a reply through the gateway

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** a signed-in user and a configured AI Gateway
- **When** the client sends messages without `stream`
- **Then** the response is the model's chat completion, and the model was called with the server's model, the messages, `max_tokens`, and gateway metadata containing the user id

### UC-CHAT-001-S02: Reply streams as server-sent events

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** a signed-in user
- **When** the client sends messages with `stream: true`
- **Then** the response is `text/event-stream` with OpenAI-style `delta` chunks that join into the full reply

### UC-CHAT-001-S03: Extension client streams the reply

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** the extension has a valid session
- **When** its client code sends a message to the worker
- **Then** it receives each chunk as it arrives and resolves with the full reply

### UC-CHAT-001-S04: Without a gateway the model is called directly

- Priority: P2 · Strategy: api-test · Status: ✅
- **Given** no AI Gateway is configured
- **When** a signed-in user sends messages
- **Then** the model is called without gateway options

### UC-CHAT-001-S05: Invalid requests are rejected without calling the model

- Priority: P1 · Strategy: api-test · Status: ✅
- **When** the body has no messages, is not a JSON object, or names a model other than the server's
- **Then** each request gets `400` and the model is not called

### UC-CHAT-001-S06: Naming the server's model is allowed

- Priority: P2 · Strategy: api-test · Status: ✅
- **When** the request names exactly the server's model
- **Then** the request succeeds

### UC-CHAT-001-S07: Model failure returns 502

- Priority: P1 · Strategy: api-test · Status: ✅
- **Given** the model call fails
- **When** a signed-in user sends messages
- **Then** the response is `502` with error code `provider_error` and the failure message

### UC-CHAT-001-S08: User chats in the side panel

- Priority: P0 · Strategy: ai-e2e · Status: ✅
- **Given** a signed-in user with the side panel open on a Notion tab
- **When** the user types a message and presses Enter
- **Then** the message appears, followed by the AI reply streaming in
