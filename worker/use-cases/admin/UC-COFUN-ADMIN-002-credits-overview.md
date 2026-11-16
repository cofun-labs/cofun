# UC-COFUN-ADMIN-002: See granted and spent credits as a whole

## Behavior

The operator needs to know how the service's credits move as a whole, not one account at a time (UC-COFUN-ADMIN-001). On the admin page they pick a period of days and see, for the whole period and for each of its days: the credits granted, by where they came from (the weekly free credits, granted by hand, or bought), the credits spent, the number of calls made to the AI model with how many of them failed, the tokens those calls used, and the pages rendered in a browser for users, with how many gave no page, the browser time they used, and what they cost, and the web searches made for users, with how many gave no results and what they cost. Every call that did not end well is a failed call, the ones the user stopped included; those are also counted on their own, as cancelled. Of the credits spent, they also see what no credits covered and so was forgiven: a spend that costs more than what is left takes what is left, so requests sent at once can together spend beyond an account's balance.

For the period they also see what was spent through each product (Notico, and each extension that follows it), with the number of model calls, of pages rendered, and of web searches, and what the renders and the searches cost, the product that spent the most first. A call is counted under the product the extension says it was made from; a call that names no product is counted on its own, as unknown. The service takes the extension's word for it: the product only sorts what was spent, so a wrong one costs no one anything. Credits are one balance per account, whichever products spend them.

For the same period they see the accounts that were granted or spent credits in it: what each was granted and spent in the period, its model calls, the pages it had rendered and the web searches it made, what each cost, what of it was forgiven, and its balance now, with the account that spent the most first. From there they open an account's own record (UC-COFUN-ADMIN-001). An account is shown by its user id only.

A day is a calendar day on the operator's own clock. A grant belongs to the day it was made, and a model call, a render, or a search, with what it cost, to the day it ended, when it was charged.

Key constraints:

- Only operators can see the overview. Anyone else who is signed in is refused, whatever they ask for.
- Looking at the overview changes nothing about any account.
- A period is bounded: the overview never covers more than a limited number of days, and the list of accounts never more than a limited number of accounts.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-ADMIN-002-S01 | P0 | ✅ | Given accounts that were granted credits and spent them over several days; when an operator looks at a period; then they see the credits granted by source, the credits spent, the model calls with how many failed, and their tokens, for the whole period and for each of its days. |
| UC-COFUN-ADMIN-002-S02 | P0 | ✅ | Given accounts that were granted or spent credits in a period; when an operator looks at the period's accounts; then each is listed with what it was granted and spent in the period and its balance now, the one that spent the most first, and the balance is the one the account's own record shows. |
| UC-COFUN-ADMIN-002-S03 | P0 | ✅ | Given a signed-in user who is not an operator; when they ask for the overview or the accounts of a period; then they are refused. |
| UC-COFUN-ADMIN-002-S04 | P1 | ✅ | Given grants and model calls just before, at the edges of, and just after a period; when an operator looks at the period; then its first and last day count in full and nothing outside it counts. |
| UC-COFUN-ADMIN-002-S05 | P1 | ✅ | Given an operator whose clock is ahead of or behind UTC; when they look at a period; then each grant and model call counts on the day it happened on the operator's clock. |
| UC-COFUN-ADMIN-002-S06 | P1 | ✅ | Given more accounts in a period than the list may show; when an operator looks at the period's accounts; then they see the ones that spent the most, and that there are more. |
| UC-COFUN-ADMIN-002-S07 | P1 | ✅ | Given an operator; when they ask for a period that is longer than allowed or ends before it starts; then it is refused. |
| UC-COFUN-ADMIN-002-S08 | P1 | ✅ | Given an account that has not used the AI this week; when an operator looks at the overview and the accounts; then no account changes, and the account's week of free credits still starts, in full, when the user next asks the AI. |
| UC-COFUN-ADMIN-002-S09 | P1 | ✅ | Given a model call the user stopped; when an operator looks at its period; then it counts as a failed call, and as a cancelled one. |
| UC-COFUN-ADMIN-002-S10 | P1 | ✅ | Given accounts that used the AI from different products, and calls that named no product; when an operator looks at a period; then they see what each product spent and its model calls, with the calls from no product counted as unknown, the one that spent the most first. |
| UC-COFUN-ADMIN-002-S12 | P1 | ✅ | Given accounts that had pages rendered, some of which gave no page, from different products; when an operator looks at a period; then they see the renders, how many failed, the browser time, and what they cost, in all and for each day, and for each product and each account. |
| UC-COFUN-ADMIN-002-S13 | P1 | ✅ | Given accounts that made web searches, some of which gave no results, from different products; when an operator looks at a period; then they see the searches, how many failed, and what they cost, in all and for each day, and for each product and each account. |
| UC-COFUN-ADMIN-002-S11 | P1 | ✅ | Given accounts that bought credits in a period; when an operator looks at the period; then the credits bought are counted on their own among the credits granted, for the whole period and for each of its days. |
| UC-COFUN-ADMIN-002-S14 | P1 | ✅ | Given accounts whose spends cost more than the credits they had left, as when requests are sent at once; when an operator looks at a period; then they see what no credits covered, and so was forgiven, in all, for each day, and for each account. |

### ai-e2e

(none)
