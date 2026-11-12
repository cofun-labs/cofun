# UC-ADMIN-002: See granted and spent credits as a whole

## Behavior

The operator needs to know how the service's credits move as a whole, not one account at a time (UC-ADMIN-001). On the admin page they pick a period of days and see, for the whole period and for each of its days: the credits granted, by where they came from (the weekly free credits, or granted by hand), the credits spent, the number of calls made to the AI model with how many of them failed, and the tokens those calls used.

For the same period they see the accounts that were granted or spent credits in it: what each was granted and spent in the period, and its balance now, with the account that spent the most first. From there they open an account's own record (UC-ADMIN-001). An account is shown by its user id only.

A day is a calendar day on the operator's own clock. A grant belongs to the day it was made, and a model call, with what it cost, to the day it started.

Key constraints:

- Only operators can see the overview. Anyone else who is signed in is refused, whatever they ask for.
- Looking at the overview changes nothing about any account.
- A period is bounded: the overview never covers more than a limited number of days, and the list of accounts never more than a limited number of accounts.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-ADMIN-002-S01 | P0 | ✅ | Given accounts that were granted credits and spent them over several days; when an operator looks at a period; then they see the credits granted by source, the credits spent, the model calls with how many failed, and their tokens, for the whole period and for each of its days. |
| UC-ADMIN-002-S02 | P0 | ✅ | Given accounts that were granted or spent credits in a period; when an operator looks at the period's accounts; then each is listed with what it was granted and spent in the period and its balance now, the one that spent the most first, and the balance is the one the account's own record shows. |
| UC-ADMIN-002-S03 | P0 | ✅ | Given a signed-in user who is not an operator; when they ask for the overview or the accounts of a period; then they are refused. |
| UC-ADMIN-002-S04 | P1 | ✅ | Given grants and model calls just before, at the edges of, and just after a period; when an operator looks at the period; then its first and last day count in full and nothing outside it counts. |
| UC-ADMIN-002-S05 | P1 | ✅ | Given an operator whose clock is ahead of or behind UTC; when they look at a period; then each grant and model call counts on the day it happened on the operator's clock. |
| UC-ADMIN-002-S06 | P1 | ✅ | Given more accounts in a period than the list may show; when an operator looks at the period's accounts; then they see the ones that spent the most, and that there are more. |
| UC-ADMIN-002-S07 | P1 | ✅ | Given an operator; when they ask for a period that is longer than allowed or ends before it starts; then it is refused. |
| UC-ADMIN-002-S08 | P1 | ✅ | Given an account that has not used the AI this week; when an operator looks at the overview and the accounts; then no account changes, and the account's week of free credits still starts, in full, when the user next asks the AI. |

### ai-e2e

(none)
