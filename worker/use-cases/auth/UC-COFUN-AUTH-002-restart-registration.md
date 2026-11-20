# UC-COFUN-AUTH-002: Restart an expired registration

## Behavior

A new user can abandon an incomplete registration after its verification expires and start a fresh registration from the same page.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-AUTH-002-S01 | P1 | ✅ | Given a new user whose registration verification has expired; when they choose to start registration again; then the old attempt is cleared and the registration form opens. |
