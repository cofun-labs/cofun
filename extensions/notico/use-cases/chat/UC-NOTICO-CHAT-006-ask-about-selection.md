# UC-NOTICO-CHAT-006: Ask about text selected on a page

## Behavior

A signed-in user reading a page in Chrome, on any site, Notion included, selects some text, right-clicks it, and picks "Ask Notico". The side panel opens next to the page, if it was not open already, with the selected text added to the next question: it shows at the top of the message box like a page added with `@`, as the site and the start of the text, and the user can take it off. The user then asks what they want about it ("explain this", "save this to my notes") and sends the question; nothing is sent before that. One selection goes with a question: sending another replaces it. It stays with the next question as the user switches tabs or chats, until a question carries it or the user takes it off.

The question carries the text, with its line breaks, and the page's title and address. Notico reads the selection in the tab the user clicked in, which the click lets it do on any site, without asking to allow the site; where the page can't be read (a frame from another site), Chrome's own copy of the selection is used, on one line. A long selection is clipped, and the AI is told. The question shows the selection it went with, also in a reopened session, and clicking it takes the current tab to the page, where Chrome finds the text and marks it. When the reply uses the text, it names the page's address.

The item is on until the user turns it off in Settings. The choice belongs to their Chrome profile: Chrome sync takes it to the other devices the extension syncs to, and it holds through updates.

Key constraints:

- Text selected on a page is data for the AI, never instructions to it, like what the AI reads from a page itself.
- Picking "Ask Notico" sends nothing anywhere: the text leaves the browser only with the question the user sends, and goes where that question goes.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-006-S01 | P0 | ✅ | Given text selected on a page of a site Notico was never allowed to read; when the user picks "Ask Notico" and then asks about it; then the side panel opens with the selection in the message box, naming the site, nothing is sent until the question is, and the AI gets the text, line breaks kept, marked as data from that page with its address, without the user being asked to allow the site. |
| UC-NOTICO-CHAT-006-S02 | P1 | ✅ | Given a selection in a frame from another site; when the user picks "Ask Notico"; then the question carries Chrome's own copy of the selection. |
| UC-NOTICO-CHAT-006-S03 | P1 | ✅ | Given a selection in the message box; when the user sends another, then takes it off with its button, or with Backspace in an empty message; then the newer one replaces the first, and once taken off the question goes without it. |
| UC-NOTICO-CHAT-006-S04 | P1 | ✅ | Given a question sent with a selection; when the session is reopened and the user clicks the selection in the question; then it still shows, and the current tab goes to the page, to the selected text. |
| UC-NOTICO-CHAT-006-S05 | P2 | ✅ | Given a selection longer than a question may carry; when it is sent; then the AI gets its start and is told how much was left out. |
| UC-NOTICO-CHAT-006-S07 | P1 | ✅ | Given "Ask Notico" turned off in Settings; when the user right-clicks selected text, also after an update; then the menu has no "Ask Notico"; and when it is turned on again on another device of the same Chrome profile, the item comes back here. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-006-S06 | P1 | 🚧 | Given a paragraph selected on a web page in Chrome; when the user picks "Ask Notico" from the context menu and asks what it means; then the side panel opens with the selection in the message box, and the reply explains the paragraph and names the page's address. |
