# UC-CHAT-003: See credits, usage, and the plan

## Behavior

A signed-in user needs to know how much of the AI they can still use (see UC-CHAT-001 for what credits are). From their account in the side panel they see how many credits are left, when those expire, and when their next free credits arrive. A settings page shows the same in full, with the account they are signed in to, their plan, and how many credits they used on each recent day, by the days of their own clock.

Free credits arrive only when the user asks the AI. Until then, a user with no current week of free credits (a new user, or one whose week has ended) is shown the credits their next question starts with, as not started yet: the free credits, less anything they overspent before.

From the settings page they can open the history of their credits: every lot of credits they were given, newest first, the expired ones included, each with how many it was, the day it was given, the day it expires or expired, and what went unspent when it expired; and the credits they used per day, as far back as they have used the AI.

The credits shown are current after every question. When a question is refused for lack of credits, the refusal says when credits arrive and leads to the settings page.

Key constraints:

- Looking at credits changes nothing: it never starts the week of free credits.
- A user sees only their own credits, usage, and history.
- Credits are for information: the chat works the same when they cannot be shown.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-003-S01 | P0 | ✅ | Given a user who used some of this week's credits; when they look at their credits; then they see how many are left, when they expire, and when their next free credits arrive. |
| UC-CHAT-003-S02 | P0 | ✅ | Given a user with no current week of free credits; when they look at their credits; then they see the free credits their next question starts with, as not started, and their week starts only with that question, with exactly those credits. |
| UC-CHAT-003-S03 | P1 | ✅ | Given a user who overspent their credits; when they look at their credits; then they see none left, and once their week has ended, the next free credits less what they overspent. |
| UC-CHAT-003-S04 | P1 | ✅ | Given a user who asked the AI on several days; when they look at their usage; then they see the credits used on each of those days, by the days of their own clock. |
| UC-CHAT-003-S05 | P0 | ✅ | Given two users; when one looks at their credits, usage, or history; then they see only their own. |
| UC-CHAT-003-S06 | P1 | ✅ | Given a user with the side panel open; when a question of theirs ends; then the credits shown are what is left after it. |
| UC-CHAT-003-S07 | P1 | ✅ | Given a user with no credits left; when they ask the AI from the side panel; then the refusal says when credits arrive and leads to the settings page. |
| UC-CHAT-003-S08 | P1 | ✅ | Given the user's credits cannot be read; when they use the side panel; then they can still ask the AI, and the panel says the credits are unavailable instead of showing a number. |
| UC-CHAT-003-S09 | P1 | ✅ | Given a signed-in user; when they open their account in the side panel; then they see which account they are signed in to and their plan. |
| UC-CHAT-003-S10 | P1 | ✅ | Given a user who was given credits over several weeks; when they open their credit history; then they see every lot of credits they were given, newest first, the expired ones included, each with how many it was, when it was given, when it expires or expired, and what went unspent. |
| UC-CHAT-003-S11 | P1 | ✅ | Given a user who asked the AI longer ago than the recent days the settings page shows; when they go further back in their usage; then they see the credits used on each of those days, by the days of their own clock. |

### ai-e2e

(none)
