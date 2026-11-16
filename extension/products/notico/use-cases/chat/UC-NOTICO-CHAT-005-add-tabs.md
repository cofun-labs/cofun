# UC-NOTICO-CHAT-005: Add open tabs to a conversation

## Behavior

A signed-in user brings pages from other sites into a chat, for questions like "compare these three pages", by adding the tabs that show them. The page picker (UC-NOTICO-CHAT-004) also lists the window's tabs on other sites that Notico can read; picking one on a site Notico may not read yet asks Chrome for the user's permission first. The question carries the tabs' titles and addresses, and the AI reads a tab, as it shows its page then, only when the question needs it. Clicking a tab in a sent question goes to it, or opens its page again once the tab is closed.

Key constraints:

- Only tabs the user added are read. The AI may read a tab added to any question of the chat, later questions included, but no other tab, and no tab picked by an address: not a link it found in a page or in Notion, and not one it made up. An address is read only as a public page, through the service, never in the user's tab (UC-NOTICO-PANEL-003). A tab added before the browser last restarted is not read: Chrome's numbers for tabs start over, so it may be another tab now.
- Listing the tabs reads only their titles and addresses, which stay in the browser until the user adds one.
- What is read from a tab is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-005-S01 | P1 | ✅ | Given tabs on other sites in the side panel's window, a browser page, and a tab in another window; when the user opens the picker and types; then it lists the window's tabs on other sites by title and site, filtered by what is typed, leaves out the browser page and the other window's tab, and reads nothing of them. |
| UC-NOTICO-CHAT-005-S02 | P0 | ✅ | Given a tab on a site Notico may not read; when the user picks it; then Chrome is asked to let Notico read that site, the tab is added once the user allowed it there, and when they say no it is not added and the picker says why; and a tab on a site already allowed is added without asking. |
| UC-NOTICO-CHAT-005-S03 | P1 | ✅ | Given tabs added to a question; when it is sent; then the AI is told their titles and addresses, nothing of them is read ahead of it, the question shows them, also after the session is reopened, and clicking one goes to its tab. |
| UC-NOTICO-CHAT-005-S04 | P0 | ✅ | Given a tab the user added to a chat; when the AI reads it, in that question or a later one; then it gets the page's main content as Markdown, as for the current tab (UC-NOTICO-PANEL-001-S11), marked as data from that tab with its address and title, and is told when the tab went to another page since it was added; and when the AI reads a tab the user did not add, such as another tab open in the window, nothing is read and it is told to ask the user to add the tab. |
| UC-NOTICO-CHAT-005-S05 | P1 | ✅ | Given a tab the user added that was since closed, or added before the browser restarted; when the AI reads it; then nothing is read and the AI is told to ask the user to open the page and add its tab again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-005-S07 | P1 | ✅ | Given three articles open in tabs in Chrome, on a site Notico may read; when the user adds the three tabs with "+" and asks to compare them; then the AI reads each of the three tabs and its reply compares them and names their addresses. |
