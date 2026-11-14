# UC-COFUN-CREDITS-001: Spend credits on the hosted model

## Behavior

Using the hosted AI (UC-COFUN-CHAT-001) costs credits, so what an account uses of the model is paid for out of the credits it has. A credit is a thousandth of a US dollar, and each call to the model costs what its tokens cost the service, with nothing added. Input the model reads from its cache costs less than new input, and is charged at that lower price. A question a product answers with several model calls, such as one for each round trip of a tool, costs the sum of them. A request the service refuses, and a model call that fails, cost nothing; a reply the user stops partway is charged an estimate of what it used. Each user has their own credits: what one spends or owes is never taken from another.

Every signed-in user gets 200 free credits a week. They arrive when the user asks and has no current week of credits, and they expire 7 days later; a new week starts the next time the user asks after that, so unused credits never add up, and a user back after weeks away gets one week of credits, not one for each week missed. Credits can also be bought (UC-COFUN-BILLING-001) or granted by an operator (UC-COFUN-ADMIN-001).

Key constraints:

- A user with no credits left cannot reach the model again until they get more credits: their next free credits, or credits they buy.
- A model call that starts with credits left is answered in full, even when it costs more than what was left. What it overspent is owed, and taken out of the next credits the user gets.
- Calls sent at once all start from the same balance, so each of them is answered in full, and together they can overspend by more than one call costs. Nothing bounds how many such calls run at once; what they overspend is owed like any other overspend.
- Credits that have expired cannot be spent.
- Only the service prices a call. Each reply tells the client what its call cost, so a product can show it; a call that was cut short is charged from estimated tokens, and says so.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CREDITS-001-S01 | P0 | ✅ | Given a user with no credits left; when a client asks the AI for them; then the request is refused with a message saying when their next free credits arrive, and no model is called. |
| UC-COFUN-CREDITS-001-S02 | P1 | ✅ | Given a user who ran out of credits; when they ask the AI after their week of credits has ended; then they have a new week of free credits and get a reply. |
| UC-COFUN-CREDITS-001-S03 | P1 | ✅ | Given a user whose last model call cost more than the credits they had left; when their next free credits arrive; then what they overspent is taken out of those credits first. |
| UC-COFUN-CREDITS-001-S04 | P1 | ✅ | Given a user with credits left when their week ends; when they ask the AI afterwards; then the leftover is gone and only the new week's credits can be spent. |
| UC-COFUN-CREDITS-001-S05 | P1 | ✅ | Given a model call whose input was partly read from the model's cache; when it is charged; then the cached part costs the cached price and the rest the full price. |
| UC-COFUN-CREDITS-001-S06 | P0 | ✅ | Given a signed-in user; when a model call of theirs ends; then it costs what its tokens cost, with nothing added. |
| UC-COFUN-CREDITS-001-S07 | P1 | ✅ | Given requests the service refuses (no session, a bad request, another model) and a model call that fails; when the user then asks the AI; then none of them cost anything, and all their credits are still there to spend. |
| UC-COFUN-CREDITS-001-S08 | P1 | ✅ | Given a reply streaming to the user; when they stop it partway; then it is charged an estimate of what it used so far. |
| UC-COFUN-CREDITS-001-S09 | P1 | ✅ | Given a user who last asked the AI a month ago; when they ask again; then they get one week of free credits, not one for each week they were away. |
| UC-COFUN-CREDITS-001-S10 | P1 | ✅ | Given a user who spent all their credits; when another user asks the AI; then the other user's credits are untouched and they get a reply. |
| UC-COFUN-CREDITS-001-S11 | P1 | ✅ | Given a user with a few credits left; when several calls are sent at once, each costing more than that; then every one is answered in full, and what they overspent together is taken out of the next credits the user gets. |
| UC-COFUN-CREDITS-001-S12 | P1 | ✅ | Given a model call that ran to its end; when its reply reaches the client, streamed or not; then the reply says what the call cost, the same amount the user was charged. |
| UC-COFUN-CREDITS-001-S13 | P1 | ✅ | Given a streamed reply that breaks off before the model reported its totals; when the stream ends; then the client is told what the call was charged, marked as an estimate. |

### ai-e2e

(none)
