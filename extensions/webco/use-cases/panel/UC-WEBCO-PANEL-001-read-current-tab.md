# UC-WEBCO-PANEL-001: Read the current tab

## Behavior

When a question is about the page in the active tab, the AI can look up the tab's address and title, and read the page's main content as Markdown once the user has allowed Webco to read its site; a long page is read in parts (UC-WEBCO-PANEL-005). The panel also lets the user add other tabs to a question (UC-WEBCO-CHAT-005).

Key constraints:

- The address and title of the current tab reach the AI only when it looks them up to answer a question. Its content is read from the tab only when the AI reads it for a question, and only on a site the user allowed Webco to read, with a click in the side panel; the AI can't allow a site itself. Text the user selected and sent with "Ask Webco" is the one exception, on any site (UC-WEBCO-CHAT-006).
- What is read from a page is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-WEBCO-PANEL-001-S05 | P1 | ✅ | Given the side panel open on a tab; when the AI looks up the current tab; then it gets that tab's address and title, and nothing else of the site. |
| UC-WEBCO-PANEL-001-S11 | P0 | ✅ | Given a tab on a site the user allowed Webco to read; when the AI reads the current tab; then it gets the page's main content as Markdown (headings, lists, links to web pages without their fragment, emphasis, code, quotes, and tables, with images as their alt text, and without navigation, asides, footers, form fields, or what is marked hidden), marked as data from that page with its address and title, and the user is not asked anything. |
| UC-WEBCO-PANEL-001-S12 | P0 | ✅ | Given a tab on a site the user has not allowed; when the AI reads the current tab; then nothing of the page is read until the user allows the site on the tool's card and in Chrome's prompt, after which the page is read and the site is not asked about again; when the user denies it, or leaves the page while asked, nothing is read and the AI is told why, and that asking again asks the user again; a denied read shows as declined, not as a failure; when the user presses Stop or leaves the chat while asked, nothing is read, the call shows as stopped, the question ends there, and a later answer changes nothing; when Chrome can't show its prompt, nothing is read and the AI is told not to ask again unless the user asks. |
| UC-WEBCO-PANEL-001-S13 | P0 | ✅ | Given the current tab on a host Webco uses for sign-in (Cofun's sign-in page, say), which Webco holds access to by install; when the AI reads the current tab; then nothing of the page is read, the user is not asked to allow anything, and the AI is told why. |
| UC-WEBCO-PANEL-001-S14 | P1 | ✅ | Given a tab Webco can't read (a browser page, the Chrome Web Store, a PDF at an address ending in .pdf), or a page on an allowed site that turns out to be a PDF in Chrome's viewer or to show its content only in frames; when the AI reads the current tab; then it is told why, and the user is not asked to allow anything. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-WEBCO-PANEL-001-S15 | P1 | 🚧 | Given an article in the current tab in Chrome, on a site Webco was never allowed; when the user asks for a summary of the page and clicks Allow on the tool's card, then Allow in Chrome's prompt; then Webco gets access to that site only, and the reply summarizes the article and names its address. |
