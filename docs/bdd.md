# BDD Workflow Specification

Every behavior change starts as a use case update. Use cases describe what the product does in user-visible terms; tests prove each scenario.

## Core concepts

| Term | Meaning |
|---|---|
| **Use case (UC)** | One user goal, e.g. "chat from the side panel". One file per use case. |
| **Rule** | A business invariant that must always hold for the use case. |
| **Scenario** | One concrete Given/When/Then example of the use case. |

## Given/When/Then quality

- **Given** states the starting conditions that matter, nothing more.
- **When** is a single action by the user or a client.
- **Then** states observable outcomes: HTTP status and body, what the user sees, what is (or is not) called.
- Use domain words ("signed-in user", "session token"), not implementation details ("the `verifyToken` call").
- One behavior per scenario. Split a scenario when its Then covers unrelated outcomes.

## Rules

Rules are short, testable statements that hold across all scenarios of a use case, e.g. "The model is chosen by the server; clients cannot pick another one." Every rule should be covered by at least one scenario.

## Execution strategy

| Strategy | When | How |
|---|---|---|
| `api-test` | Behavior observable through the worker's HTTP API, or the extension's client code | vitest integration tests in `worker/test/` |
| `ai-e2e` | Behavior that needs a real browser: the side panel UI, Clerk sign-in, Notion pages | An agent drives Chrome with the extension loaded and checks the result |

Prefer `api-test` whenever the behavior can be observed without a browser.

## Priority

| Priority | Meaning | Test requirement |
|---|---|---|
| P0 | Core behavior; breaking it breaks the product | Must be tested before merge |
| P1 | Important behavior | Should be tested before merge |
| P2 | Edge cases and nice-to-haves | Can be deferred |

## Status

- ❌ Not implemented, or implemented but not yet verified by its strategy
- ✅ Implemented and verified (`api-test`: a passing test exists; `ai-e2e`: verified in a real browser)

## File specification

Use cases live in `docs/use-cases/{domain}/UC-{DOMAIN}-{NNN}-{slug}.md`:

```markdown
# UC-CHAT-001: Chat from the side panel

**Actor:** Signed-in user
**Goal:** Ask the AI something and read the reply in the side panel.

## Rules

- R1: ...

## Scenarios

### UC-CHAT-001-S01: Signed-in user gets a streamed reply

- Priority: P0 · Strategy: api-test · Status: ✅
- **Given** ...
- **When** ...
- **Then** ...
```

### ID naming

- Use case: `UC-{DOMAIN}-{NNN}`, e.g. `UC-AUTH-001`. Domains: `AUTH`, `CHAT`, `PANEL`.
- Scenario: `{UC ID}-S{NN}`, e.g. `UC-AUTH-001-S03`.
- IDs are never renumbered. Deleted IDs are not reused.
- A scenario keeps its ID only for wording changes. New or changed logic gets a new ID.
- Tests start with the scenario ID: `it('[UC-AUTH-002-S01] request without a session is rejected', ...)`. One test may cover one scenario; one scenario may need several tests.

## Non-goals

- Use cases do not describe implementation (file names, functions, libraries).
- Do not write scenarios for third-party behavior (Clerk's own sign-in UI, Notion's editor), only for how this product uses them.
