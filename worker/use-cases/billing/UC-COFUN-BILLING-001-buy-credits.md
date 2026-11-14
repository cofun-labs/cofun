# UC-COFUN-BILLING-001: Buy credits

## Behavior

A user who wants more than the free credits of each week (UC-COFUN-CREDITS-001) buys a pack of credits, once: nothing renews, and there is no subscription. Their product asks the service for one of the packs on offer, priced in US dollars at a thousand credits a dollar, and gets the payment provider's own page for it, where the user pays. Once the payment goes through, the pack's credits are added to their account. What each product shows, and how, is in its own use cases (Notico's UC-NOTICO-BILLING-001).

Purchased credits last one year from the purchase. They sit beside the weekly free credits, which every user keeps getting, buyers included, and follow the same rules as any credits: the ones that expire first are spent first (so free credits go before purchased ones), and what the account overspent is taken out of them first. A purchase that is refunded or disputed loses what is left of its credits; what was already spent stays spent, and what it paid back of an overspend is owed again.

Key constraints:

- A pack's credits are added only to the account that started its checkout, and only once the payment provider reports that the payment went through.
- One payment adds its credits once, however many times it is reported, and never after it was refunded or disputed, whichever report arrives first.
- A user gets the credits of the pack they chose, whatever currency they paid in and whatever tax was added; a payment for anything else adds no credits.
- Payment details are entered on the payment provider's page only, and never reach the products or the service.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-BILLING-001-S01 | P0 | ✅ | Given a signed-in user; when they choose a pack on offer; then they get the payment page for that pack, for their account. |
| UC-COFUN-BILLING-001-S02 | P0 | ✅ | Given a user who paid for a pack; when the payment goes through; then the pack's credits are added to their account until a year later, spent after their free credits, and their weekly free credits still arrive. |
| UC-COFUN-BILLING-001-S03 | P0 | ✅ | Given a payment that is reported more than once; when each report arrives; then its credits are added once. |
| UC-COFUN-BILLING-001-S04 | P0 | ✅ | Given a report of a payment that does not come from the payment provider; when it arrives; then no credits are added. |
| UC-COFUN-BILLING-001-S05 | P1 | ✅ | Given a user who paid in another currency, with tax added; when the payment goes through; then they get exactly the credits of the pack they chose. |
| UC-COFUN-BILLING-001-S06 | P1 | ✅ | Given a user who paid with a method that completes later; when the payment goes through, the pack's credits are added; when it fails, none are. |
| UC-COFUN-BILLING-001-S07 | P1 | ✅ | Given a user who overspent their credits; when they buy a pack; then what they overspent is taken out of it first. |
| UC-COFUN-BILLING-001-S08 | P1 | ✅ | Given a user who spent part of a purchase; when it is refunded or disputed; then what is left of it is taken back, what was spent stays spent, and their other credits are untouched. |
| UC-COFUN-BILLING-001-S09 | P1 | ✅ | Given a user who asks for a pack that is not on offer; when they try to buy it; then they are refused and no payment page is made. |
| UC-COFUN-BILLING-001-S10 | P1 | ✅ | Given a payment for something other than the pack its checkout was made for; when it goes through; then no credits are added. |
| UC-COFUN-BILLING-001-S11 | P1 | ✅ | Given a user whose purchase paid back what they had overspent; when the purchase is refunded or disputed; then they owe that again. |
| UC-COFUN-BILLING-001-S12 | P2 | ✅ | Given a payment whose refund is reported before the payment itself; when the report of the payment arrives; then no credits are added. |

### ai-e2e

(none)
