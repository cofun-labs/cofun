# UC-COFUN-CREDITS-001: Spend credits on the hosted model

## Behavior

Using the hosted AI (UC-COFUN-CHAT-001) costs credits, so one account cannot run up unbounded model usage. Credits are one balance per account, whichever products spend them. A credit is a thousandth of a US dollar, and each call to the model costs what its tokens cost the service, with nothing added. Input the model reads from its cache costs less than new input, and is charged at that lower price. A question a product answers with several model calls, such as one for each round trip of a tool, costs the sum of them.

Every signed-in user gets 200 free credits a week. They arrive when the user asks and has no current week of credits, and they expire 7 days later; a new week starts the next time the user asks after that, so unused credits never add up. Credits can also be bought (UC-COFUN-BILLING-001) or granted by an operator (UC-COFUN-ADMIN-001).

Key constraints:

- A user with no credits left cannot reach the model again until they get more credits: their next free credits, or credits they buy.
- A model call that starts with credits left is answered in full, even when it costs more than what was left. What it overspent is taken out of the next credits the user gets.
- Credits that have expired cannot be spent.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CREDITS-001-S01 | P0 | ✅ | Given a user with no credits left; when a client asks the AI for them; then the request is refused with a message saying when their next free credits arrive, and no model is called. |
| UC-COFUN-CREDITS-001-S02 | P1 | ✅ | Given a user who ran out of credits; when they ask the AI after their week of credits has ended; then they have a new week of free credits and get a reply. |
| UC-COFUN-CREDITS-001-S03 | P1 | ✅ | Given a user whose last model call cost more than the credits they had left; when their next free credits arrive; then what they overspent is taken out of those credits first. |
| UC-COFUN-CREDITS-001-S04 | P1 | ✅ | Given a user with credits left when their week ends; when they ask the AI afterwards; then the leftover is gone and only the new week's credits can be spent. |
| UC-COFUN-CREDITS-001-S05 | P1 | ✅ | Given a model call whose input was partly read from the model's cache; when it is charged; then the cached part costs the cached price and the rest the full price. |

### ai-e2e

(none)
