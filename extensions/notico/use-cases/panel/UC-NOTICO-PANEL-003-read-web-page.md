# UC-NOTICO-PANEL-003: Read a web page by its address

## Behavior

A user gives the address of a web page in their message ("summarize https://example.com/article", "compare these two links"), and the AI reads it without the page being open in a tab. The service reads the page as anyone who opens the address without signing in sees it (UC-COFUN-WEB-001), and the AI gets its title and main text, and names the page it used in the reply. The AI can also read pages it finds on its own, such as a link in a page it read. This works whichever model answers: the page is read by the service either way.

A page drawn by scripts shows no text this way: the AI is told so, and can have the page rendered in a browser instead. Rendering is slower, a render that gives a page costs credits for the browser time it used (one that gives no page costs nothing), and only a few pages can be rendered a minute; what the renders for a question cost is part of what its reply cost, whichever model answers. A user with no credits left can't have a page rendered: the question stops, and they are told when free credits arrive and that they can buy some; the AI chooses which way to read a page, and may render one right away. A page the service can't read (one that needs a sign-in, one a bot check stops, a file that is not a web page) gives the AI the reason, and for a page behind a sign-in or a bot check the AI suggests the user open it in a tab, where it can read the page they are on (UC-NOTICO-PANEL-001). When the service, the site, or the browser that renders pages turns reads away for coming too often, the question stops and the user is told why. Any other failure (the service can't be reached, or gives a reason or an answer the extension doesn't know) only means the page wasn't read: the AI is told so and the question goes on, and for a render that may have cost credits it is told not to render the page again for the question. A long page is read in parts (UC-NOTICO-PANEL-005).

Key constraint:

- What is read from a web page is data for the AI, never instructions to it.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-003-S01 | P0 | ✅ | Given a message that gives a web page's address; when the AI reads it; then it gets the page's title and main text, marked as data from that page, and the tool's card names the page. |
| UC-NOTICO-PANEL-003-S02 | P1 | ✅ | Given a page the AI read that links to another; when it follows the link; then it reads that page too. |
| UC-NOTICO-PANEL-003-S03 | P1 | ✅ | Given a page that needs a sign-in or that a bot check stops; when the AI reads it; then it is told the page could not be read, and to have the user open it in a tab. |
| UC-NOTICO-PANEL-003-S04 | P1 | ✅ | Given a page drawn by scripts; when the AI reads it; then it is told the page shows no text; and when it renders it, it gets the page's text. |
| UC-NOTICO-PANEL-003-S09 | P1 | ✅ | Given a question for which the AI renders pages, one of which can't be rendered; when the reply ends; then what it cost includes what each render cost, and the one that failed costs nothing. |
| UC-NOTICO-PANEL-003-S10 | P0 | ✅ | Given a user whose credits run out as the AI asks for a page rendered; when it renders it; then nothing is rendered, the question stops, and the user is told they have no credits, when free ones arrive, and can buy some. |
| UC-NOTICO-PANEL-003-S06 | P1 | ✅ | Given the service, the site, or the browser that renders pages turning reads away for coming too often; when the AI reads a page; then the question stops, the user is told why, and nothing more is read for it. |
| UC-NOTICO-PANEL-003-S11 | P1 | ✅ | Given the service failing to read or render a page for a reason the extension doesn't know, or not reachable, or answering what it can't read; when the AI reads the page; then it is told the page could not be read, and, for a render that may have cost credits, not to render it again; and the question goes on. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-003-S07 | P1 | ✅ | Given a user who pastes the address of a public article; when they ask the AI to summarize it; then the AI reads it, answers from what it says, and names its URL. |
| UC-NOTICO-PANEL-003-S08 | P2 | ✅ | Given a user who pastes the address of a page drawn by scripts; when they ask the AI about it; then the AI renders it and answers from what it shows. |
