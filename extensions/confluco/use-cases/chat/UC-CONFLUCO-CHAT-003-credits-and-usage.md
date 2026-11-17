# UC-CONFLUCO-CHAT-003: See credits and usage

## Behavior

A signed-in user needs to know how much of the AI they can still use (UC-COFUN-CREDITS-001 says what credits are and how they are spent). The account menu shows the credits left; the Credits page shows them by source, the packs to buy, the credits used on each of the last 30 days, and the history of every lot of credits they were given. Each reply that ended normally shows what it cost, and the credits shown are current after every question. They see only their own credits (UC-COFUN-CREDITS-002).

Key constraints:

- Looking at credits changes nothing: it never starts the week of free credits.
- Credits are for information: the chat works the same when they cannot be shown.

## Scenarios

### api-test

| ID                       | Priority | Status | Scenario                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-CONFLUCO-CHAT-003-S01 | P0       | ✅     | Given a user who used some of this week's credits; when they look at their credits; then the account menu shows how many are left, and the Credits page shows them by source, with when new free credits can arrive.                                                                                                                       |
| UC-CONFLUCO-CHAT-003-S02 | P0       | ✅     | Given a user with no current week of free credits; when they look at their credits; then they see the free credits their next question starts with, as not started, and their week starts only with that question, with exactly those credits.                                                                                             |
| UC-CONFLUCO-CHAT-003-S03 | P1       | ✅     | Given a user whose last question cost more than the credits they had left; when they look at their credits; then they see none left, nothing owed, and once their week has ended, the next free credits in full.                                                                                                                           |
| UC-CONFLUCO-CHAT-003-S04 | P1       | ✅     | Given a user who asked the AI on several days, some longer ago than the last 30; when they open the Credits page; then they see the credits used on each of the last 30 days, by the days of their own clock, with the total for those days and today's, and nothing used before them shows in their credits or their history.             |
| UC-CONFLUCO-CHAT-003-S06 | P1       | ✅     | Given a user with the side panel open; when a question of theirs ends; then the credits shown are what is left after it.                                                                                                                                                                                                                   |
| UC-CONFLUCO-CHAT-003-S07 | P1       | ✅     | Given a user with no credits left; when they ask the AI from the side panel; then the refusal says when free credits arrive, offers to buy credits, and leads to the Credits page.                                                                                                                                                         |
| UC-CONFLUCO-CHAT-003-S08 | P1       | ✅     | Given the user's credits cannot be read; when they use the side panel; then they can still ask the AI, and the panel says the credits are unavailable instead of showing a number.                                                                                                                                                         |
| UC-CONFLUCO-CHAT-003-S12 | P1       | ✅     | Given a signed-in user; when they open their account in the side panel; then they see which account they are signed in to, then Credits with the credits left and Settings, each opening its page, and Sign out; and Settings shows the model providers (UC-CONFLUCO-AGENT-002) and the account, with Sign out, and nothing about credits. |
| UC-CONFLUCO-CHAT-003-S14 | P1       | ✅     | Given a reply on the hosted model that the user stopped, or that ended in an error, after a step, or a reply from the user's own model with no page rendered or search made for it; when it ends; then no cost is shown under it, though the credits shown still include what a stopped or failed reply was charged.                       |
| UC-CONFLUCO-CHAT-003-S15 | P1       | ✅     | Given a reply that read web pages, rendered one, and searched the web; when the user opens its details; then they count the web pages read, how many were rendered, and the searches, and split what the reply cost into the model, the renders, and the searches.                                                                         |

### ai-e2e

(none)
