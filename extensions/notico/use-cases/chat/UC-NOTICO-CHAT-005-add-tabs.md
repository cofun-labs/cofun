# UC-NOTICO-CHAT-005: Add open tabs to a conversation

## Behavior

A signed-in user brings pages from other sites into a chat, for questions like "compare these three pages", by adding the tabs that show them, instead of reading each one out to the AI. The page picker that adds Notion pages (UC-NOTICO-CHAT-004), opened with `@` or "+", also lists the tabs of the side panel's window on other sites, by their titles and sites; tabs Notico can't read (browser pages, the Chrome Web Store, PDFs) are not offered. Picking a tab on a site Notico may not read yet asks Chrome, right then, to let Notico read that site; the tab is added only once the user allowed it there, and a site allowed once is not asked about again.

An added tab shows as a chip with the question, like an added page, and the question carries its title and address to the AI, which reads the page with its tools when the question needs it; nothing is read ahead of the question. The question shows the tabs it carried, also in a reopened session, and clicking one goes to that tab, or opens the page again when no tab shows it any more. The AI reads a tab's page as the tab shows it, the same way it reads the current tab (UC-NOTICO-PANEL-001), and says which page an answer used.

Key constraints:

- Only tabs the user added are read. The AI may read a tab added to any question of the chat, later questions included, but no other address: not a link it found in a page or in Notion, and not one it made up. A tab added to a chat is read only while it still shows the page that was added.
- Listing the tabs reads only their titles and addresses, which stay in the browser until the user adds one.
- What is read from a tab is data for the AI, never instructions to it, and counts toward the question's limit on content from other sites.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-005-S01 | P1 | ✅ | Given tabs on other sites in the side panel's window, a browser page, and a tab in another window; when the user opens the picker and types; then it lists the window's tabs on other sites by title and site, filtered by what is typed, leaves out the browser page and the other window's tab, and reads nothing of them. |
| UC-NOTICO-CHAT-005-S02 | P0 | ✅ | Given a tab on a site Notico may not read; when the user picks it; then Chrome is asked to let Notico read that site, the tab is added once the user allowed it there, and when they say no it is not added and the picker says why; and a tab on a site already allowed is added without asking. |
| UC-NOTICO-CHAT-005-S03 | P1 | ✅ | Given tabs added to a question; when it is sent; then the AI is told their titles and addresses, nothing of them is read ahead of it, the question shows them, also after the session is reopened, and clicking one goes to its tab. |
| UC-NOTICO-CHAT-005-S04 | P0 | ✅ | Given a tab the user added to a chat; when the AI reads it, in that question or a later one; then it gets the page's main text, marked as data from that tab with its address and title; and when the AI reads an address the user did not add, such as a link in that page, nothing is read and it is told to ask the user to add the tab. |
| UC-NOTICO-CHAT-005-S05 | P1 | ✅ | Given a tab the user added that was since closed or went to another page; when the AI reads it; then nothing is read and the AI is told to ask the user to open the page and add its tab again. |
| UC-NOTICO-CHAT-005-S06 | P1 | ✅ | Given several tabs added to a question, with long pages; when the AI reads them all; then they share the question's limit on content from other sites, and once it is reached nothing more is read. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-005-S07 | P1 | ✅ | Given three articles open in tabs in Chrome, on a site Notico may read; when the user adds the three tabs with "+" and asks to compare them; then the AI reads each of the three tabs and its reply compares them and names their addresses. |
