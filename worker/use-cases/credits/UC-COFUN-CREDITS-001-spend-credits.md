# UC-COFUN-CREDITS-001: Spend credits on the hosted model

## Behavior

Using the hosted AI (UC-COFUN-CHAT-001) costs credits. A credit is a thousandth of a US dollar, and each model call costs what its tokens cost the service, with nothing added. A request the service refuses, and a model call that fails, cost nothing; a reply the user stops partway is charged an estimate of what it used.

Every signed-in user gets 200 free credits a week, starting when they ask and expiring 7 days later, so unused credits never add up. Credits can also be bought (UC-COFUN-BILLING-001) or granted by an operator (UC-COFUN-ADMIN-001).

Key constraints:

- A user with no credits left cannot reach the model again until they get more credits: their next free credits, or credits they buy.
- A request whose input alone is estimated to cost more than the credits left is refused before the model is called, with a message saying about how many credits it needs and how many are left. The estimate goes by the size of the input, all of it at the price of input read from the model's cache, so a long chat the model has cached is not refused for much more than it would spend.
- A model call that starts with credits left, enough for its input, is answered in full, even when it costs more than what was left. It takes only what was left: credits never go below zero, and what it cost beyond them is forgiven, never owed or taken out of later credits.
- Calls sent at once all start from the same balance, so each of them is answered in full, and together they can cost more than one call beyond it. That is forgiven too; how many calls one user can start in a minute, how many they can have going at once (3, across all their products), and how long a reply may be, are capped, which bounds it.
- A call is charged when the model is done with it, whether or not the product has read the whole reply yet.
- Credits that have expired cannot be spent.
- Only the service prices a call. Each reply tells the client what its call cost, so a product can show it; a reply the user stopped before the model reported its totals is charged from estimated tokens, and says so.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CREDITS-001-S01 | P0 | ✅ | Given a user with no credits left; when a client asks the AI for them; then the request is refused with a message saying when their next free credits arrive, and no model is called. |
| UC-COFUN-CREDITS-001-S02 | P1 | ✅ | Given a user whose week of credits has ended, with credits left or none, a week or a month ago; when they ask the AI; then the leftover is gone, they have one new week of free credits, not one for each week they were away, and they get a reply. |
| UC-COFUN-CREDITS-001-S03 | P1 | ✅ | Given a user whose last model call cost more than the credits they had left; when it is charged; then it takes only what was left, and their next free credits arrive in full. |
| UC-COFUN-CREDITS-001-S05 | P1 | ✅ | Given a model call whose input was partly read from the model's cache; when it is charged; then the cached part costs the cached price and the rest the full price. |
| UC-COFUN-CREDITS-001-S06 | P0 | ✅ | Given a signed-in user; when a model call of theirs ends; then it costs what its tokens cost, with nothing added. |
| UC-COFUN-CREDITS-001-S07 | P1 | ✅ | Given requests the service refuses (no session, a bad request, another model) and a model call that fails; when the user then asks the AI; then none of them cost anything, and all their credits are still there to spend. |
| UC-COFUN-CREDITS-001-S08 | P1 | ✅ | Given a reply streaming to the user; when they stop it partway; then it is charged an estimate of what it used so far. |
| UC-COFUN-CREDITS-001-S10 | P1 | ✅ | Given a user who spent all their credits; when another user asks the AI; then the other user's credits are untouched and they get a reply. |
| UC-COFUN-CREDITS-001-S11 | P1 | ✅ | Given a user with a few credits left; when several calls are sent at once, each costing more than that; then every one is answered in full, their credits end at zero, and their next free credits arrive in full. |
| UC-COFUN-CREDITS-001-S12 | P1 | ✅ | Given a model call that ran to its end; when its reply reaches the client, streamed or not; then the reply says what the call cost, the same amount the user was charged. |
| UC-COFUN-CREDITS-001-S13 | P1 | ✅ | Given a streamed reply that breaks off, or ends in the model's error, after it streamed part of the reply; when the stream ends; then the call costs nothing, and the client is told so. |
| UC-COFUN-CREDITS-001-S15 | P1 | ✅ | Given a user with a few credits left; when a client asks the AI with an input estimated to cost more than that; then the request is refused with a message saying about how many credits it needs and how many are left, no model is called, and a short question still gets a reply. |
| UC-COFUN-CREDITS-001-S16 | P0 | ✅ | Given a user with 3 answers being written; when they ask the AI again; then the request is refused with a message to wait for one to finish, costs nothing, and no model is called, while other users still get replies; once one is written, they can ask again. |
| UC-COFUN-CREDITS-001-S14 | P1 | ✅ | Given a user who has started many calls within the last minute; when they ask the AI again; then the request is refused with a message to wait a minute, costs nothing, and no model is called, while other users still get replies. |

### ai-e2e

(none)
