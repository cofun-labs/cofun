# UC-CONFLUCO-CONFLUENCE-001: Use the Confluence site in the current tab

## Behavior

Confluco works on the Confluence site open in the current tab, with nothing to set up first. An Atlassian Cloud site is recognized by its wiki address. A self-managed page names its deployment path in Confluence's page metadata, and the page must sit under that path. The first time a Confluence tool needs a site Confluco may not use yet, the tool's card asks the user to allow it, and Chrome asks too. A site the user allowed stays allowed for later questions. A question stays on the site it was asked on. A tab that is not a Confluence page is refused without asking for access.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S01 | P0 | ✅ | Given a Cloud wiki page whose site Confluco may not use yet; when a Confluence tool runs and the user allows the site on the card and in Chrome; then the tool reads the page, and a later question on that site does not ask again. |
| UC-CONFLUCO-CONFLUENCE-001-S02 | P0 | ✅ | Given a Cloud wiki page whose site Confluco may not use yet; when the user denies access on the card or in Chrome's prompt; then nothing is sent to the site and the model is told the user did not allow it. |
| UC-CONFLUCO-CONFLUENCE-001-S03 | P0 | ✅ | Given an allowed self-managed page; when a Confluence tool runs; then requests go under the deployment path the page names, and a page that names no path or a path that does not contain it is refused with no request. |
| UC-CONFLUCO-CONFLUENCE-001-S04 | P1 | ✅ | Given a tab that is not a Confluence page, such as a news site or a Jira page on an Atlassian tenant; when a Confluence tool runs; then it is refused without asking to allow the site. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S05 | P0 | ✅ | Given a real Chrome profile signed in to a Cloud site that Confluco may not use yet; when the user asks about the page and allows the site on the card and in Chrome; then the read tools use the tab's session. |
| UC-CONFLUCO-CONFLUENCE-001-S06 | P1 | 🚧 | Given a real Chrome profile on a self-managed Confluence page with a deployment path; when the user asks about the page and allows the site; then the read tools use that path. |
