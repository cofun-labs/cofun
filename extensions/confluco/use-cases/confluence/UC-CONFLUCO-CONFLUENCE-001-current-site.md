# UC-CONFLUCO-CONFLUENCE-001: Use the Confluence site in the current tab

## Behavior

Confluco works on the Confluence site open in the current tab, with nothing to set up first. An Atlassian Cloud site is recognized by its wiki address. A self-managed page names its deployment path in Confluence's page metadata, and the page must sit under that path. The first time a tool needs a site Confluco may not use yet, its card asks the user, and Chrome asks too. A site allowed stays allowed, and a question stays on the site it was asked on. A tab that is not a Confluence page is refused without asking for access. Each question tells the AI only whether the tab is (or may be) a Confluence page. A tool may also name a page by a link on that site, or by a reference a tool returned earlier in the question.

### api-test

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S01 | P0 | ✅ | Given a Cloud wiki page whose site Confluco may not use yet; when a Confluence tool runs and the user allows the site on the card and in Chrome; then the tool reads the page, and a later question on that site does not ask again. |
| UC-CONFLUCO-CONFLUENCE-001-S02 | P0 | ✅ | Given a Cloud wiki page whose site Confluco may not use yet; when the user denies access on the card or in Chrome's prompt; then nothing is sent to the site and the model is told the user did not allow it. |
| UC-CONFLUCO-CONFLUENCE-001-S03 | P0 | ✅ | Given an allowed self-managed page; when a Confluence tool runs; then requests go under the deployment path the page names, and a page that names no path or a path that does not contain it is refused with no request. |
| UC-CONFLUCO-CONFLUENCE-001-S04 | P1 | ✅ | Given a tab that is not a Confluence page, such as a news site or a Jira page on an Atlassian tenant; when a Confluence tool runs; then it is refused without asking to allow the site. |
| UC-CONFLUCO-CONFLUENCE-001-S07 | P1 | ✅ | Given the current tab is an allowed Confluence page, a page on another site (or a Jira page), or a Cloud wiki page whose site Confluco may not use yet; when the user asks a question; then the question carries a note that the tab is a Confluence page, is not one, or may be one, without the tab's address or title, and asking it sends nothing to the site and asks for no access. |
| UC-CONFLUCO-CONFLUENCE-001-S08 | P1 | ✅ | Given a link to another page on the Confluence site in the current tab; when a read or a change names the page by that link; then the tool works on that page, and a link to a page on another site is refused with no request. |
| UC-CONFLUCO-CONFLUENCE-001-S09 | P1 | ✅ | Given a page a Confluence change created earlier in the question; when a later tool names it by the reference that change returned; then the tool works on that page without finding it again. |

### ai-e2e

| ID | Priority | Status | Scenario |
|---|---|---|---|
| UC-CONFLUCO-CONFLUENCE-001-S05 | P0 | ✅ | Given a real Chrome profile signed in to a Cloud site that Confluco may not use yet; when the user asks about the page and allows the site on the card and in Chrome; then the read tools use the tab's session. |
| UC-CONFLUCO-CONFLUENCE-001-S06 | P1 | 🚧 | Given a real Chrome profile on a self-managed Confluence page with a deployment path; when the user asks about the page and allows the site; then the read tools use that path. |
