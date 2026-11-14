# UC-NOTICO-CHAT-003: See credits and usage

## Behavior

A signed-in user needs to know how much of the AI they can still use (see UC-COFUN-CREDITS-001 for what credits are and how they are spent). From their account in the side panel they see how many credits are left, when those expire, and when their next free credits arrive. A settings page shows the same in full, with the account they are signed in to and how many credits they used on each recent day, by the days of their own clock. They see only their own (UC-COFUN-CREDITS-002).

Free credits arrive only when the user asks the AI. Until then, a user with no current week of free credits (a new user, or one whose week has ended) is shown the credits their next question starts with, as not started yet: the free credits, less anything they overspent before.

From the settings page they can open the history of their credits: every lot of credits they were given (free, added by an operator, or bought; see UC-NOTICO-BILLING-001), newest first, the expired ones included, each with how many it was, the day it was given, the day it expires or expired, and what went unspent when it expired; and the credits they used per day, as far back as they have used the AI.

Under each reply on the hosted model, next to its Copy button, the user sees what the question cost in credits: every model call behind the reply, added up, as the service charged them (UC-COFUN-CREDITS-001). When part of it is an estimate, because a call was cut short or the user stopped the reply, the cost is marked as approximate. A reply from the user's own model spends no credits and shows no cost. A reopened chat shows each reply's cost as it was.

The credits shown are current after every question. When a question is refused for lack of credits, the refusal says when credits arrive and leads to the settings page.

Key constraints:

- Looking at credits changes nothing: it never starts the week of free credits.
- Credits are for information: the chat works the same when they cannot be shown.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-003-S01 | P0 | ✅ | Given a user who used some of this week's credits; when they look at their credits; then they see how many are left, when they expire, and when their next free credits arrive. |
| UC-NOTICO-CHAT-003-S02 | P0 | ✅ | Given a user with no current week of free credits; when they look at their credits; then they see the free credits their next question starts with, as not started, and their week starts only with that question, with exactly those credits. |
| UC-NOTICO-CHAT-003-S03 | P1 | ✅ | Given a user who overspent their credits; when they look at their credits; then they see none left, and once their week has ended, the next free credits less what they overspent. |
| UC-NOTICO-CHAT-003-S04 | P1 | ✅ | Given a user who asked the AI on several days; when they look at their usage; then they see the credits used on each of those days, by the days of their own clock. |
| UC-NOTICO-CHAT-003-S06 | P1 | ✅ | Given a user with the side panel open; when a question of theirs ends; then the credits shown are what is left after it. |
| UC-NOTICO-CHAT-003-S07 | P1 | ✅ | Given a user with no credits left; when they ask the AI from the side panel; then the refusal says when credits arrive and leads to the settings page. |
| UC-NOTICO-CHAT-003-S08 | P1 | ✅ | Given the user's credits cannot be read; when they use the side panel; then they can still ask the AI, and the panel says the credits are unavailable instead of showing a number. |
| UC-NOTICO-CHAT-003-S10 | P1 | ✅ | Given a user who was given credits over several weeks; when they open their credit history; then they see every lot of credits they were given (free, added by an operator, or bought; see UC-NOTICO-BILLING-001), newest first, the expired ones included, each with how many it was, when it was given, when it expires or expired, and what went unspent. |
| UC-NOTICO-CHAT-003-S11 | P1 | ✅ | Given a user who asked the AI longer ago than the recent days the settings page shows; when they go further back in their usage; then they see the credits used on each of those days, by the days of their own clock. |
| UC-NOTICO-CHAT-003-S12 | P1 | ✅ | Given a signed-in user; when they open their account in the side panel; then they see which account they are signed in to. |
| UC-NOTICO-CHAT-003-S13 | P1 | ✅ | Given a question the hosted model answered in several steps; when its reply ends; then the row under the reply shows what all of its model calls cost in credits, and the reopened chat shows it too. |
| UC-NOTICO-CHAT-003-S14 | P1 | ✅ | Given a reply on the hosted model that the user stopped after a step; when it stops; then the row under it shows its cost marked as approximate. |
| UC-NOTICO-CHAT-003-S15 | P1 | ✅ | Given a user who uses their own model; when its reply ends; then no cost in credits is shown under it. |

### ai-e2e

(none)
