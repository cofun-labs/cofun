# UC-AUTH-001: Sign in through the web sign-in page

**Actor:** Notion user with the extension installed
**Goal:** Sign in once on a normal web page (including with Google) and be signed in inside the side panel.

## Rules

- R1: Sign-in happens on the worker's `/login` page, not inside the side panel. Social logins need a redirect, which Chrome side panels do not support.
- R2: The extension never stores credentials. It reads the Clerk session from the sign-in page's domain (Clerk Sync Host).
- R3: An open side panel reflects sign-in and sign-out without the user reopening it.

## Scenarios

### UC-AUTH-001-S01: Sign-in page shows Clerk's sign-in UI

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** the worker is configured with a Clerk publishable key
- **When** a browser requests `GET /login`
- **Then** the response is an HTML page that loads Clerk's JS and UI bundles from that instance's Frontend API, with the publishable key

### UC-AUTH-001-S02: Root URL goes to the sign-in page

- Priority: P2 · Strategy: api-test · Status: ✅
- **When** a browser requests `GET /`
- **Then** it is redirected to `/login`

### UC-AUTH-001-S03: Sign-in page is off without a publishable key

- Priority: P1 · Strategy: api-test · Status: ✅
- **Given** the worker has no Clerk publishable key
- **When** a browser requests `GET /login`
- **Then** the response is `503` with error code `not_configured`

### UC-AUTH-001-S04: Signing in on the web page signs in the side panel

- Priority: P0 · Strategy: ai-e2e · Status: ❌
- **Given** the extension is loaded, a Notion tab is open, and the side panel shows "Sign in"
- **When** the user clicks "Sign in", completes Google sign-in on the page that opens, and returns to the Notion tab
- **Then** the side panel shows the chat view and the user button, without being reopened

### UC-AUTH-001-S05: Signing out signs out the side panel

- Priority: P1 · Strategy: ai-e2e · Status: ❌
- **Given** the user is signed in and the side panel shows the chat view
- **When** the user signs out from the side panel's user button
- **Then** the side panel shows "Sign in" again
