# UC-COFUN-ADMIN-001: Look at an account's credits and grant credits by hand

## Behavior

The operator needs to help a single account: see what credits it has, and give it more. On the admin page they look an account up by its user id and see its balance and every grant it was given, the expired ones included, with where it came from, what is left, and when it expires. They can grant it credits by hand, for a number of days; those follow the same rules as any credits (UC-COFUN-CREDITS-001): the credits that expire first are spent first, and none can be spent after they expire.

Key constraints:

- Only operators can look at an account or grant credits. Anyone else who is signed in is refused, whatever they ask for, and nothing changes.
- Looking at an account changes nothing about it.
- Credits granted by hand never stand in for the weekly free credits or delay them.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-ADMIN-001-S01 | P0 | ✅ | Given an operator; when they look up an account; then they see its balance and every grant it was given, with what is left of each and when it expires. |
| UC-COFUN-ADMIN-001-S02 | P0 | ✅ | Given an operator; when they grant an account credits for a number of days; then the user can spend those credits, beside their weekly free credits, until they expire. |
| UC-COFUN-ADMIN-001-S03 | P0 | ✅ | Given a signed-in user who is not an operator; when they try to look up an account or grant credits; then they are refused and no account changes. |
| UC-COFUN-ADMIN-001-S04 | P1 | ✅ | Given an account whose grants have expired; when an operator looks it up; then the expired grants are still in its record, and count for nothing in its balance. |
| UC-COFUN-ADMIN-001-S06 | P1 | ✅ | Given an account that has not used the AI this week; when an operator looks it up or grants it credits; then its week of free credits still starts, in full, when the user next asks the AI. |
| UC-COFUN-ADMIN-001-S07 | P1 | ✅ | Given an operator; when they enter more credits or more days than a grant may have; then the grant is refused and the account does not change. |
| UC-COFUN-ADMIN-001-S08 | P1 | ✅ | Given an account that bought credits; when an operator looks it up; then each purchase is in its record as a purchase, beside the other grants, and a refunded or disputed one shows what was taken back. |

### ai-e2e

(none)
