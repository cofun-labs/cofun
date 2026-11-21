# UC-WEBCO-BILLING-001: Buy credits

## Behavior

A user who wants more than each week's free credits buys a pack of credits, once, from the Credits page in the side panel: nothing renews, and there is no subscription. They pay on the payment provider's own page, in a new tab, and the side panel shows the new credits when they come back. Their credits and history show what they bought and what a refund took back, and a question refused for lack of credits offers to buy more.

What a payment adds, how bought credits are spent, and what a refund or dispute takes back are the service's rules, the same in every product: UC-COFUN-BILLING-001.

Key constraint:

- Payment details are entered on the payment provider's page only, and never reach the side panel or the service.

## Scenarios

### api-test

| ID                       | Priority | Status | Scenario                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-WEBCO-BILLING-001-S01 | P0       | ✅     | Given a signed-in user on the Credits page; when they choose a pack; then the payment provider's own page for that pack opens in a new tab, for their account, and the side panel asks for no payment details.                                                                                     |
| UC-WEBCO-BILLING-001-S10 | P1       | ✅     | Given a user who paid in the tab the side panel opened; when they come back to the side panel; then it shows their new credits.                                                                                                                                                                    |
| UC-WEBCO-BILLING-001-S11 | P1       | ✅     | Given a user who bought credits; when they look at their credits and their history; then the purchase shows as such, with what they paid and the day it expires, and a refunded purchase shows what was taken back.                                                                                |
| UC-WEBCO-BILLING-001-S15 | P1       | ✅     | Given a signed-in user on the Credits page; when they look at the packs on offer; then they are told that bought credits last one year from the purchase, that nothing renews, and that questions answered with their own key spend credits only on pages rendered and web searches made for them. |

### ai-e2e

(none)
