---
name: bdd-audit
description: Audit how well the use cases in docs/use-cases and the tests cover the product's business rules, and list the gaps for the maintainer to pick from. Run before a release or after a large feature. Reports only; edits nothing.
---

# BDD coverage audit

Use cases are a structural aid for test coverage and stability (`docs/bdd.md`), not a strict ledger, so per-PR rules stay light and gaps are found here, now and then. This audit produces a gap list. **It does not edit use cases, tests, or code**, and opens no Issue or PR: the maintainer picks what to fix, usually in one PR.

Read `docs/bdd.md` first for what a use case, a scenario, and the two strategies (`api-test`, `ai-e2e`) are.

## Steps

1. **Run the coverage check.** `pnpm use-cases`. Note every error (a ✅ `api-test` scenario no test names) and warning (a 🚧 scenario that already has a test, a test naming an ID no use case has, an ID in more than one row, a test naming an `ai-e2e` scenario).

2. **Promises with no scenario.** For each use case in `docs/use-cases/**/UC-*.md`, read its Behavior and Key constraints and list each promise a user or client relies on that no scenario expresses. Each Key constraint needs at least one scenario. Also look for promises the code no longer keeps (a constraint the implementation dropped): those are gaps too, in the use case or in the code.

3. **Untagged tests that guard a business rule.** Read the tests without a `[UC-…]` ID in `worker/test/` and `extensions/*/test/`. Most are implementation details and should stay untagged (status codes, CORS, config errors, regressions). List only those that guard a rule a user would notice if it broke, such as how something is charged, what is refused, or what is kept between questions.

4. **Tests that don't match their scenario.** For each tagged test, compare its name and what it asserts with the scenario line it names. List tests that check something else, or only part of the scenario's "then".

5. **Suggest a fix for each gap.** One of: a scenario line to add (`Given …; when …; then …`, with its strategy and priority by the table in `docs/bdd.md`), an ID to put on an existing test, a test to write or rename, or a use case sentence to change.

Use subagents to read use cases or test folders in parallel when there are many; the gap list is yours to assemble.

## Output

A short list grouped by use case, most important first, every item naming the file (and the test or scenario ID) it is about. Keep each item to a line or two. For example:

```markdown
### UC-CHAT-001 (docs/use-cases/notico/chat/UC-CHAT-001-side-panel-chat.md)

- Behavior: "each call to the model costs what its tokens cost" is guarded only by an untagged test
  (worker/test/api.test.ts, "a call is charged what its tokens cost").
  Suggest: api-test P1 "Given a model call; when it is charged; then it costs what its tokens cost, with nothing added." and tag that test.
- Behavior: "one account cannot run up unbounded model usage", but calls sent at once can each overspend
  (worker/test/api.test.ts, "calls sent at once all start on the same balance, and what they overspent is owed").
  Suggest: decide whether the constraint or the code changes, then a P1 scenario for the bound.

### UC-NOTION-002 (docs/use-cases/notico/notion/UC-NOTION-002-edit-page.md)

- Behavior promises an edit applies whole or not at all; no scenario says so.
  Suggest: api-test P0 "Given an edit Notion refuses partway; when the agent makes it; then the page is left as it was."

### Coverage check

- (none), or the errors and warnings from `pnpm use-cases`, one per line.
```

End with one line: how many gaps, and how many are P0. Then ask the maintainer which ones to fix.
