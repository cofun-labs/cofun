# UC-AUTH-002: API access requires a valid session

**Actor:** The extension (or any client) calling the worker's `/v1/*` API
**Goal:** Only signed-in users of this product can use the AI API.

## Rules

- R1: Every `/v1/*` request carries a Clerk session token as `Authorization: Bearer <token>`.
- R2: The worker verifies the token locally with the Clerk JWT public key: signature and expiry. If the token has an authorized party (`azp`), it must be one of the allowed origins. Tokens the extension gets through Clerk's Native API have no `azp`, because the request has no origin.
- R3: A rejected request never reaches the model.
- R4: Browsers may call the API from any origin (CORS `*`), because auth uses bearer tokens, not cookies.

## Scenarios

### UC-AUTH-002-S01: Request without a session is rejected

- Priority: P0 · Strategy: api-test · Status: ✅
- **When** a client calls `/v1/chat/completions` without a bearer token
- **Then** the response is `401` with error code `unauthorized`

### UC-AUTH-002-S02: Invalid, forged, or expired tokens are rejected

- Priority: P0 · Strategy: api-test · Status: ✅
- **When** a client sends a malformed token, a token signed by another key, or an expired token
- **Then** each request gets `401` and the model is not called

### UC-AUTH-002-S03: Token issued for another origin is rejected

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** a valid token whose `azp` is not an allowed origin
- **When** a client uses it
- **Then** the response is `401`

### UC-AUTH-002-S04: Any allowed origin is accepted

- Priority: P1 · Strategy: api-test · Status: ✅
- **Given** a valid token whose `azp` is the second origin in the allowed list
- **When** a client uses it
- **Then** the request succeeds

### UC-AUTH-002-S05: API is off without the JWT key

- Priority: P1 · Strategy: api-test · Status: ✅
- **Given** the worker has no Clerk JWT public key configured
- **When** a client calls the API with a token
- **Then** the response is `503` with error code `not_configured`

### UC-AUTH-002-S06: Client can read who it is signed in as

- Priority: P2 · Strategy: api-test · Status: ✅
- **Given** a signed-in user
- **When** the client calls `GET /v1/me`
- **Then** the response contains the Clerk user id and the server's model

### UC-AUTH-002-S07: Extension origin passes CORS preflight

- Priority: P0 · Strategy: api-test · Status: ✅
- **When** a `chrome-extension://` origin sends a CORS preflight to `/v1/chat/completions`
- **Then** the response is `204` and allows any origin

### UC-AUTH-002-S08: Extension asks the user to sign in when there is no session

- Priority: P1 · Strategy: api-test · Status: ✅
- **Given** the extension has no Clerk session
- **When** it tries to send a chat message
- **Then** it fails with "Please sign in first." without calling the worker

### UC-AUTH-002-S09: Extension shows the server's reason for a rejected session

- Priority: P2 · Strategy: api-test · Status: ✅
- **Given** the worker rejects the extension's token
- **When** the extension sends a chat message
- **Then** the error shown is the server's message ("invalid or expired session")

### UC-AUTH-002-S10: Token without an origin is accepted

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** a valid token with no `azp`, as Clerk issues to the extension through its Native API
- **When** a client uses it
- **Then** the request succeeds as that user
