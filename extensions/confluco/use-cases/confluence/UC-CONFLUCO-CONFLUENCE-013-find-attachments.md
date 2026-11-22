# UC-CONFLUCO-CONFLUENCE-013: Find attachments on a Confluence page

## Behavior

A user can find attachments on a published page and open their download links on the Confluence instance in the current tab. Confluco does not upload or replace files: the user does that in Confluence.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-013-S01 | P1 | ✅ | Given a published page with attachments; when the user lists them; then Confluco returns a bounded batch and usable download links for that page. |
