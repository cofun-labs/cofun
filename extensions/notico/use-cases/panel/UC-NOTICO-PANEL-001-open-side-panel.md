# UC-NOTICO-PANEL-001: Open the side panel on any tab

## Behavior

A user opens the AI side panel from the extension's toolbar icon on any tab, and can chat there. The panel stays open, with its conversation, as the user switches tabs, to a Notion page or away from one.

Reading and changing Notion works only while the current tab is a Notion page. On any other tab the AI is told just that: that the current tab is not a Notion page. It still answers what it can, and when a request needs Notion it tells the user to switch to a Notion page. When a question needs to know where the user is, the AI can look up the current tab's address and title, on Notion or any other site.

On another site, the AI can also read the page in the current tab when a question is about it, such as summarizing an article or saving it to Notion. It reads the page's main text as the tab shows it, so pages the user is signed in to and pages drawn by scripts read as they look. The first time it reads a site, the tool's card asks the user to allow Notico to read that site, and Chrome asks once more; the page is read only once both said yes, and a site allowed once is not asked about again. A page Notico can't read (a browser page, the Chrome Web Store, a PDF in Chrome's viewer, a page whose content is all in frames) gives the AI the reason instead, and on a Notion page the AI reads with the Notion tools. A long page is clipped, one question reads only so much from other sites, and the reply names the page it used.

Key constraints:

- The AI works on the current tab only. A Notion page open in another tab is never used in its place, and no tab other than the current one is read.
- The address and title of a tab on another site reach the AI only when it looks them up to answer a question. Its content is read only when the AI reads it for a question, and only on a site the user allowed Notico to read, with a click in the side panel; the AI can't allow a site itself.
- What is read from another site is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S03 | P0 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks a question; then the AI answers, having been told only that the current tab is not a Notion page, not its address or title. |
| UC-NOTICO-PANEL-001-S04 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the AI tries to read or change Notion; then nothing is asked of Notion, and the AI is told to have the user switch to a Notion page. |
| UC-NOTICO-PANEL-001-S05 | P1 | ✅ | Given the side panel open on a tab on another site; when the AI looks up the current tab; then it gets that tab's address and title, and nothing else of the site. |
| UC-NOTICO-PANEL-001-S06 | P1 | ✅ | Given the side panel open on a Notion page; when the AI looks up the current tab; then it gets that tab's address and title. |
| UC-NOTICO-PANEL-001-S10 | P0 | ✅ | Given another Notion page open in a tab in the background; when the AI reads "this page" with a Notion page in the current tab, and then with another site in the current tab; then the first reads the current tab's page, in that tab, and the second asks nothing of Notion in any tab and tells the AI to have the user switch to a Notion page. |
| UC-NOTICO-PANEL-001-S11 | P0 | ✅ | Given a tab on a site the user allowed Notico to read; when the AI reads the current tab; then it gets the page's main text, clipped when long, marked as data from that page with its address and title, and the user is not asked anything. |
| UC-NOTICO-PANEL-001-S12 | P0 | ✅ | Given a tab on a site the user has not allowed; when the AI reads the current tab; then nothing of the page is read until the user allows the site on the tool's card and in Chrome's prompt, after which the page is read and the site is not asked about again; when the user denies it, or leaves the page while asked, nothing is read and the AI is told why. |
| UC-NOTICO-PANEL-001-S13 | P1 | ✅ | Given a tab Notico can't read (a browser page, the Chrome Web Store, a PDF at an address ending in .pdf) or a Notion page, or a page on an allowed site that turns out to be a PDF in Chrome's viewer or to show its content only in frames; when the AI reads the current tab; then it is told why, the user is not asked to allow anything, and nothing is asked of Notion. |
| UC-NOTICO-PANEL-001-S14 | P1 | ✅ | Given a question that has read as much from other sites as one question may; when the AI reads the current tab again; then nothing more is read and the AI is told so, and the next question can read again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-001-S01 | P0 | ✅ | Given a Notion page in the active tab; when the user clicks the toolbar icon; then the side panel opens next to the page. |
| UC-NOTICO-PANEL-001-S08 | P0 | ✅ | Given another site in the active tab; when the user clicks the toolbar icon; then the side panel opens next to it. |
| UC-NOTICO-PANEL-001-S07 | P1 | ✅ | Given a conversation in the side panel on a Notion page; when the user switches to a tab on another site; then the panel stays open with the conversation, and the next question continues it. |
| UC-NOTICO-PANEL-001-S09 | P1 | ✅ | Given the side panel open on a tab that is not a Notion page; when the user asks for something that needs Notion, such as a summary of this page; then the AI says it needs a Notion page and asks them to switch to one, without making anything up. |
| UC-NOTICO-PANEL-001-S15 | P1 | 🚧 | Given an article on another site in the current tab in Chrome, a site Notico was never allowed; when the user asks for a summary of the page and clicks Allow on the tool's card, then Allow in Chrome's prompt; then Notico gets access to that site only, and the reply summarizes the article and names its address. |
