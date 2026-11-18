# UC-CONFLUCO-CONFLUENCE-013: Manage attachments on a Confluence page

## Behavior

A user can find attachments on a published page and open download links on the connected Confluence instance. They can select one local file to upload. The assistant previews the destination and the file before asking for confirmation. Confluco requires an explicit replacement request when it finds an existing attachment with that name. Confluence Cloud matches files by filename, so a same-name attachment added concurrently after the final check can receive a new version. The Cloud confirmation explains that behavior. File contents stay between the browser and the connected instance.

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-013-S01 | P0 | ✅ | Given a published page with attachments; when the user lists them; then Confluco returns a bounded batch and usable download links for that page. |
| UC-CONFLUCO-CONFLUENCE-013-S02 | P0 | ✅ | Given a selected local file and a self-managed or Cloud published page; when the user confirms an upload or explicit replacement; then Confluco verifies the attachment and its resulting version. |
| UC-CONFLUCO-CONFLUENCE-013-S03 | P0 | ✅ | Given a missing file, a name collision detected before submission, a changed target or a declined confirmation; when a write is requested; then Confluco leaves the existing attachments intact. |
| UC-CONFLUCO-CONFLUENCE-013-S04 | P0 | ✅ | Given a denied or unverifiable upload; when the user receives its result; then Confluco reports the outcome without repeating the write. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CONFLUCO-CONFLUENCE-013-S05 | P0 | ✅ | Given a disposable self-managed published page and synthetic files; when the user uploads, lists, downloads and replaces an attachment; then the expected file and new version are available on the same page. |
| UC-CONFLUCO-CONFLUENCE-013-S06 | P0 | ✅ | Given a disposable Cloud published page and synthetic files; when the user confirms an upload and a same-name replacement and lists the attachments; then one attachment has the expected filename and version 2 and a usable download link. |
