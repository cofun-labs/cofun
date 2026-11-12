# UC-ADMIN-001: Look at an account's credits and grant credits by hand

## Behavior

The operator needs to help a single account: see what credits it has, and give it more. On an admin page they look an account up by its user id and see its balance and the record of every grant it was given: where the credits came from, how many, how many are left, when they were granted, and when they expire. Grants stay in that record after they expire.

They can grant the account credits by hand, entering the number of credits and how many days they last each time. Credits granted by hand sit beside the weekly free credits (UC-CHAT-001) and follow the same rules: the credits that expire first are spent first, what the account overspent is taken out of them first, and they cannot be spent after they expire.

Key constraints:

- Only operators can look at an account or grant credits. Anyone else who is signed in is refused, whatever they ask for, and nothing changes.
- Looking at an account changes nothing about it.
- Credits granted by hand never stand in for the weekly free credits or delay them.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-ADMIN-001-S01 | P0 | ✅ | Given an operator; when they look up an account; then they see its balance and every grant it was given, with what is left of each and when it expires. |
| UC-ADMIN-001-S02 | P0 | ✅ | Given an operator; when they grant an account credits for a number of days; then the user can spend those credits, beside their weekly free credits, until they expire. |
| UC-ADMIN-001-S03 | P0 | ✅ | Given a signed-in user who is not an operator; when they try to look up an account or grant credits; then they are refused and no account changes. |
| UC-ADMIN-001-S04 | P1 | ✅ | Given an account whose grants have expired; when an operator looks it up; then the expired grants are still in its record, and count for nothing in its balance. |
| UC-ADMIN-001-S05 | P1 | ✅ | Given an account that overspent its credits; when an operator grants it credits; then what it overspent is taken out of them first. |
| UC-ADMIN-001-S06 | P1 | ✅ | Given an account that has not used the AI this week; when an operator looks it up or grants it credits; then its week of free credits still starts, in full, when the user next asks the AI. |
| UC-ADMIN-001-S07 | P1 | ✅ | Given an operator; when they enter more credits or more days than a grant may have; then the grant is refused and the account does not change. |

### ai-e2e

(none)
