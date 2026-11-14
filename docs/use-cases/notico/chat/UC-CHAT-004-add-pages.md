# UC-CHAT-004: Add Notion pages to a question

## Behavior

A signed-in user says which Notion pages a question is about, instead of naming them in words and hoping the AI finds them. The message box shows the pages the question goes with at its top: the page open in the current tab is there by default (UC-AGENT-001), and the user adds more.

Typing `@` in the message box opens a page picker, filtered by what the user types after the `@`; choosing a page takes the `@…` text out of the message. The "+" button in the message box opens a small menu whose "Add a page…" opens the same picker, with its own search field, and leaves the message as it is. The picker lists, in groups: this page (the one open in the current tab, marked when the question carries it already), the other Notion pages open in the browser's tabs, pages recent chats went with or the AI read or changed in them, and, once the user has typed at least two characters and stopped typing for a moment, the first pages Notion's search finds in the workspace. Each page shows its title, with the typed text in bold, and, when Notion's search says, where it is in the workspace. The arrow keys move, Enter adds, and Escape closes the picker and leaves what was typed as text. When nothing matches, the picker says so. Words after an `@` that go on past a space and match no page already in the browser are taken as the message going on: the picker closes and they stay text, so Enter sends them as typed (the "+" picker's own field searches any words).

Each chosen page shows as a chip the user can remove; Backspace in an empty message removes the last one. A page added by hand stays with the question when the tab moves to another page; the open page's own chip follows the tab. The question carries the pages' titles and addresses to the AI, which reads what it needs of them with its tools; nothing is read ahead of the question. The question shows the pages it carried, also in a reopened session. The next question starts again with only the open page.

Key constraints:

- Listing this page, the open tabs, and recent pages asks nothing of Notion.
- Searching the workspace is gentle on the user's Notion account: one search at a time, only after typing pauses, and never retried. When Notion turns a search away, the picker says Notion is busy and searches no more for that question; the other groups stay usable.
- No data leaves the browser for a host it did not go to before: the search goes to Notion from the user's Notion tab, and the pages a question carries go where the question goes.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-004-S01 | P1 | ✅ | Given the side panel on a Notion page, another Notion page open in a tab, and an earlier chat whose AI read a page; when the user types `@` and then some text; then the picker lists this page marked as added, the other tab's page, and the page read, filtered by the text with it in bold, says when nothing matches, and asks nothing of Notion. |
| UC-CHAT-004-S02 | P1 | ✅ | Given the picker open from `@`; when the user moves to a page with the arrow keys and presses Enter; then it shows as a chip and the `@…` text is gone; and when they type another `@` and press Escape, the picker closes and the text stays. |
| UC-CHAT-004-S03 | P1 | ✅ | Given a message being typed; when the user presses "+", chooses "Add a page…", and picks a page from the picker's own search; then the page shows as a chip and the message is unchanged. |
| UC-CHAT-004-S04 | P1 | ✅ | Given a page added to the question; when the user presses Backspace in the empty message box twice; then the added page, and then the open page, come off the question, and the AI is told no page goes with it. |
| UC-CHAT-004-S05 | P1 | ✅ | Given the picker open; when the user types one character, then more, pausing only after the third, and types again while the search runs; then nothing is searched for one character or before the pause, one search goes out with the text typed so far, the next waits until it has answered, and its first 8 pages show with where they are. |
| UC-CHAT-004-S06 | P1 | ✅ | Given Notion turns the workspace search away (429 or 529); when the user goes on typing; then the picker says Notion is busy, nothing is retried or searched again for that question, the open tabs can still be added, and the next question searches again. |
| UC-CHAT-004-S07 | P1 | ✅ | Given a page added to a question; when it is sent; then the AI is told the open page and the added page by title and address, nothing is read from Notion ahead of it, the question shows both pages, also after the session is reopened, and the next question starts with only the open page. |
| UC-CHAT-004-S08 | P1 | ✅ | Given the open page taken off the question; when the user picks it in the picker and then moves the tab to another page; then it goes with the question as an added page, next to the new open page. |
| UC-CHAT-004-S10 | P1 | ✅ | Given a message with an `@` followed by ordinary words, such as "Meet me @ 5pm" or "ping @team about it"; when the user presses Enter; then the message is sent as typed, nothing is searched, and no page is added. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-CHAT-004-S09 | P1 | 🚧 | Given the side panel on a real Notion page in Chrome, with another Notion page open in a tab; when the user adds that page with `@`, adds a page found by the workspace search, and asks to compare them; then the AI reads the pages the question carries and answers about them, and the reply's details show only the Notion requests the agent made. |
