# UC-COFUN-CREDITS-002: Read one's own credits and history

## Behavior

A signed-in user's product reads, for them, their credits (UC-COFUN-CREDITS-001), their usage per day over the last 30 days, and the history of the credits they were given (with what each purchase cost), to show them. Older usage is not read: no product shows it. What each product shows, and how, is in its own use cases (Notico's UC-NOTICO-CHAT-003).

Key constraint:

- A user reads only their own credits, usage, and history.
- How many requests one user can make in a minute, apart from asking the AI, is capped: reading their credits, usage, and history, starting a purchase (UC-COFUN-BILLING-001), and an operator's requests (UC-COFUN-ADMIN-001) all count toward one cap, far above what a product needs. Asking the AI has its own cap (UC-COFUN-CREDITS-001), and neither counts toward the other.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CREDITS-002-S01 | P0 | ✅ | Given two users; when one looks at their credits, usage, or history; then they see only their own. |
| UC-COFUN-CREDITS-002-S02 | P1 | ✅ | Given a user who has read their credits many times within the last minute; when they read them again; then the request is refused with a message to wait a minute and nothing is read, while other users still read theirs. |
| UC-COFUN-CREDITS-002-S03 | P1 | ✅ | Given a user whose question made many model calls within the last minute; when their product reads their credits; then it gets them, and a user refused for reading too often can still ask the AI. |

### ai-e2e

(none)
