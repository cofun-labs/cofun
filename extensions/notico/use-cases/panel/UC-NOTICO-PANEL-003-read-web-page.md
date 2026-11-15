# UC-NOTICO-PANEL-003: Read a web page the user gives

## Behavior

A user gives the address of a web page in their message ("summarize https://example.com/article", "compare these two links"), and the AI reads it without the page being open in a tab. The service reads the page as anyone who opens the address without signing in sees it (UC-COFUN-WEB-001), and the AI gets its title and main text, and names the page it used in the reply. This works whichever model answers: the page is read by the service either way.

A page drawn by scripts shows no text this way: the AI is told so, and can have the page rendered in a browser instead, which is slower, and only a few pages can be rendered a minute. A page the service can't read (one that needs a sign-in, one a bot check stops, a file that is not a web page) gives the AI the reason, and for a page behind a sign-in or a bot check the AI suggests the user open it in a tab, where it can read the page they are on (UC-NOTICO-PANEL-001). When the service or the site turns reads away for coming too often, the question stops and the user is told why. A long page is clipped, and one question reads only so much from outside Notion, this and the current tab together.

Key constraints:

- Only an address the user wrote in one of their own messages in the chat is read. A link the AI found in a page it read, in Notion, or one it changed or made up, is refused, and nothing is sent for it: text the AI read can't make it send a request to an address of its choosing.
- What is read from a web page is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-003-S01 | P0 | ✅ | Given a message that gives a web page's address; when the AI reads it; then it gets the page's title and main text, marked as data from that page, and the tool's card names the page. |
| UC-NOTICO-PANEL-003-S02 | P0 | ✅ | Given an address the user did not write in any of their messages (a link from a page the AI read, or one the AI changed); when the AI asks to read it; then it is refused, and nothing is sent for it; an address the user gave in an earlier question of the chat can still be read. |
| UC-NOTICO-PANEL-003-S03 | P1 | ✅ | Given a page that needs a sign-in or that a bot check stops; when the AI reads it; then it is told the page could not be read, and to have the user open it in a tab. |
| UC-NOTICO-PANEL-003-S04 | P1 | ✅ | Given a page drawn by scripts; when the AI reads it; then it is told the page shows no text; and when it renders it, it gets the page's text. |
| UC-NOTICO-PANEL-003-S05 | P1 | ✅ | Given a question that has read as much from outside Notion as one question may, from web pages and the current tab together; when the AI reads another page; then it is told it can't, and the next question can read again. |
| UC-NOTICO-PANEL-003-S06 | P1 | ✅ | Given the service or the site turning reads away for coming too often; when the AI reads a page; then the question stops, the user is told why, and nothing more is read for it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-003-S07 | P1 | 🚧 | Given a user who pastes the address of a public article; when they ask the AI to summarize it; then the AI reads it, answers from what it says, and names its URL. |
| UC-NOTICO-PANEL-003-S08 | P2 | 🚧 | Given a user who pastes the address of a page drawn by scripts; when they ask the AI about it; then the AI renders it and answers from what it shows. |
