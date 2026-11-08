# BDD Workflow Specification

Use cases record the **product behavior contract**: what users and clients can rely on, independent of the UI, libraries, or code. Tests prove it. Use cases are not a catalog of every behavior, test, or bug.

## What goes into a use case

Before adding or changing a scenario, ask two questions:

1. **Implementation swap:** if the UI, framework, or internals were replaced, would the product owner still need to review this sentence? If not, it is not a scenario.
2. **Gap:** does an existing behavior or scenario already express it? If so, reuse it.

Never write into a use case:

- HTTP status codes, API fields, error codes, headers, CORS, endpoints, functions, libraries, config.
- Bug reproduction steps or fix history.
- UI layout, wording, loading or error presentation.
- Retries, timeouts, caching, races, and other implementation risks.
- Combinations of every parameter, role, or input.

These can still be worth testing. Write them as **standalone tests**: same integration-test style, but without a scenario ID in the name.

## Structure

| Part | Contents |
|---|---|
| **Use case** | One user goal, e.g. "ask the AI from the side panel". One file per goal. Split by goal, not by UI area, endpoint, or mechanism. |
| **Behavior** | Who needs it, what they get, and the few boundaries needed to understand it. Not a list of rules. |
| **Key constraint** | Optional. Only a prohibition or invariant that holds across several scenarios and changes what the capability is. Each needs at least one scenario. |
| **Scenario** | One representative example, as one line: `Given …; when …; then …`. Only branches with their own product meaning: the main success path, rejections that matter, and real boundaries. |

A scenario earns its place only if deleting it would let an implementation pass the remaining scenarios while breaking the product contract.

## Strategy

| Strategy | Use for | Verified by |
|---|---|---|
| `api-test` | Anything observable through the worker's HTTP API or the extension's client code | A vitest integration test in `worker/test/` whose name starts with the scenario ID |
| `ai-e2e` | Paths that need a real browser: the side panel, Clerk sign-in, Notion pages | An agent drives Chrome with the extension loaded; the PR description or a comment records the run |

Pick the cheapest strategy that observes the result directly. `ai-e2e` is not a place to park scenarios that could be `api-test`.

## Priority

Priority is how much a scenario protects the product, not a schedule.

| Priority | Meaning | Before merge |
|---|---|---|
| P0 | Success path of a core capability, or a branch whose violation can't be undone (data or access crosses a trust boundary) | Must be verified |
| P1 | Important branch of one use case: alternative paths, main rejections, recoverable failures | Should be verified |
| P2 | Rare, narrow, easy to recover | Can wait |

A guard or rejection branch should not rank above its use case's success path unless it independently meets P0.

## Status

- 🚧 Not yet verified by its strategy. New and semantically changed scenarios start here.
- ✅ Verified: `api-test` has a passing test named with the ID; `ai-e2e` has a recorded passing run.

## File format

`docs/use-cases/{domain}/UC-{DOMAIN}-{NNN}-{slug}.md`:

```markdown
# UC-CHAT-001: Ask the AI from the side panel

## Behavior

A signed-in user asks the AI something in the side panel and reads the reply as it streams in.

Key constraint:

- The server chooses the model. Clients cannot use another one.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-001-S01 | P0 | ✅ | Given a signed-in user; when they ask the AI something; then the reply streams back piece by piece. |

### ai-e2e

(none)
```

## IDs

- Use case: `UC-{DOMAIN}-{NNN}`. Domains: `AGENT`, `AUTH`, `CHAT`, `PANEL`.
- Scenario: `{UC ID}-S{NN}`.
- Once merged, IDs are never renumbered and deleted IDs are not reused. A scenario keeps its ID only for wording changes; changed behavior gets a new ID.
- Test names start with the ID: `it('[UC-CHAT-001-S01] signed-in user gets a streamed reply', ...)`. Several tests may cover one scenario.
