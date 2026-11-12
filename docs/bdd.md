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
| `api-test` | Anything observable through the worker's HTTP API, the extension's client code, or the side panel's UI | A vitest integration test whose name starts with the scenario ID, in `worker/test/` (the worker's HTTP API) or `extension/test/` (the extension's client code in `*.test.ts`, the side panel's UI in `*.test.tsx`) |
| `ai-e2e` | Paths that need real Chrome or real accounts: the side panel opening and staying open across tabs, Clerk sign-in, real Notion pages, the real model | An agent drives Chrome with the extension loaded; the PR description or a comment records the run, with the Notion requests each tested question made (the side panel shows the count with the reply) |

Pick the cheapest strategy that observes the result directly. `ai-e2e` is not a place to park scenarios that could be `api-test`.

## Testing the side panel's UI

What the user sees and does in the side panel is an `api-test` too: `extension/test/*.test.tsx` run the panel in a DOM (jsdom), without a browser.

- **The whole panel runs.** A test opens the panel the way `sidepanel.html` does (`FakeBrowser` in `extension/test/panel.ts`), with the real agent, tools, and session store behind it and the real worker answering its model calls. Don't render a component on its own.
- **Only what a user can do and see.** Tests type, click, and read the screen, finding things by role, accessible name, label, or visible text. They never reach into component state, the agent, or the session store. When an element has no such handle, give it one that also helps a screen reader, not a test id.
- **Fakes only at the edges:** `chrome.*` with a Notion tab (`FakeNotionTab`), Clerk (`extension/test/clerk.tsx`), IndexedDB (`fake-indexeddb`), and the model (`FakeAiBinding`). Besides the screen, a test may look at those edges: what the model was sent, and what Notion was asked to do.
- **No real time.** The clock is fake and starts at a fixed time; a test that needs time to pass moves it. No sleeps, and no waiting for a timeout to pass. To catch the panel midway (a reply still streaming), hold the fake at the edge and release it.

A fake model answers what the test scripts, so these tests show what the panel does with a reply, not what the real model says. A scenario whose point is the real model's judgment, or real Chrome, stays `ai-e2e`.

## Running an `ai-e2e` scenario

`ai-e2e` runs use the maintainer's Chrome Canary: started with `--remote-debugging-port=9228`, signed in to Notion and to Notico, with the extension loaded unpacked. `pnpm e2e` drives it over the DevTools protocol (`pnpm e2e --help` lists every command and option):

```bash
pnpm e2e lock acquire "UC-NOTION-007-S04"    # hold the browser across all the steps
pnpm e2e reload                              # build this checkout into the extension Canary loads, reload it
pnpm e2e page "e2e S04" "## Meeting notes" "We ship on Friday." "## Next steps" "Write the notes."
pnpm e2e panel <url printed by page>         # open the side panel on that page, with a new chat
pnpm e2e ask "Turn the Meeting notes section into its own child page." --allow
pnpm e2e trash <id printed by page>          # move the throwaway page to the trash
pnpm e2e close                               # close the tabs the tool opened
pnpm e2e lock release
```

- **One browser, shared.** Several sessions use the same Canary, guarded by one lock (`~/.cache/notion-copilot/canary.lock`, shared with the maintainer's `canary-lock.sh`). Hold it for the whole run with `lock acquire` and `lock release`: between commands, another session could otherwise reload the extension (closing your panel) or start a chat in it. A command run without it takes the lock just for itself. The owner is `--owner`, `$E2E_OWNER`, or the git branch; run one command at a time per owner. A busy lock exits with code 3 and the holder's name: work on something else and try later, never wait in a loop. A lock not refreshed for 30 minutes counts as abandoned.
- **Reload first.** Canary loads one extension folder for everyone; `reload` builds this checkout over it, so start every run with it and don't assume another session's build is still there.
- **Hands off the browser's state.** The tool never signs in or out of Notion or Notico and never changes browser settings. If Developer mode is off, the extension is disabled, or a sign-in is missing, it says so and stops; fix it by hand.
- **Only its own tabs and pages.** It works in the tabs it opened (one on Notion, and one on another site for `elsewhere`), `panel` opens only on pages and databases it created, `ask` refuses any other current tab, and `trash` only takes those (`page` makes a private page from Markdown lines; `db` makes a private task database with Name, Status, and Due). Use throwaway pages, never the workspace's own.
- **Off Notion.** `elsewhere` brings a tab on another site (`example.com`) to the front, and says whether the side panel stayed open with its chat or had to be opened; `panel` goes back to the Notion tab, with a new chat. Use it for scenarios about the panel on a tab that is not Notion.
- **Approvals.** `ask` answers approval prompts with `--allow` or `--deny`. `--allow` approves every prompt, whatever it changes. The agent asks for approval only before some changes (such as deleting a page) and makes the others on its own, so the tool can't keep it on the throwaway pages: word every question so it stays on them, and never ask it to change other pages. Without either it stops at the first prompt with exit code 4 and prints what the tool would change; run `pnpm e2e ask --allow` (no question) to answer and keep waiting.
- **What `ask` prints.** The reply in order: the model's text and each tool call with its status, arguments, and result. `--json` prints the same as JSON.

Record each run in the PR description or a comment: the scenario ID, the commit it ran on, the commands, and the reply's tool calls and results that show the scenario's "then", plus anything you checked in Notion directly. Leave out account ids, emails, and the titles or content of the workspace's own pages.

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

- Use case: `UC-{DOMAIN}-{NNN}`. Domains: `ADMIN`, `AGENT`, `AUTH`, `CHAT`, `NOTION`, `PANEL`, `SESSION`.
- Scenario: `{UC ID}-S{NN}`.
- Once merged, IDs are never renumbered and deleted IDs are not reused. A scenario keeps its ID only for wording changes; changed behavior gets a new ID.
- Test names start with the ID: `it('[UC-CHAT-001-S01] signed-in user gets a streamed reply', ...)`. Several tests may cover one scenario.
