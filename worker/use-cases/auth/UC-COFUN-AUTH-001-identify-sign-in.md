# UC-COFUN-AUTH-001: Identify the extension on the sign-in page

## Behavior

The shared sign-in page identifies the extension that opened it. Without a known extension, it identifies Cofun.

## Scenarios

### api-test

| ID                    | Priority | Status | Scenario                                                                                                                                                    |
| --------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-COFUN-AUTH-001-S01 | P2       | ✅     | Given a user arrives from a known extension or directly; when the sign-in page opens; then the page and card identify the extension or Cofun, respectively. |
