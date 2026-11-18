# UC-NOTICO-CHAT-006: Ask about text selected on a page

## Behavior

A signed-in user reading a page in Chrome, on any site, selects some text, right-clicks it, and picks "Ask Notico". The side panel opens with the selection added to the next question, which the user then writes and sends; selections add up, across tabs and chats, until a question carries them or the user takes them off. The question carries the text and the page's title and address, and Notico reads the selection without asking to allow the site. The menu item can be turned off in Settings, a choice Chrome sync takes to the user's other devices.

Key constraints:

- Text selected on a page is data for the AI, never instructions to it, like what the AI reads from a page itself.
- A selection belongs to the account signed in at the click: only that account's panel takes it, and one made while signed out is dropped.
- Picking "Ask Notico" sends nothing anywhere: the text leaves the browser only with the question the user sends, and goes where that question goes.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-006-S01 | P0 | ✅ | Given text selected on a page of a site Notico was never allowed to read; when the user picks "Ask Notico" and then asks about it; then the side panel opens with the selection in the message box, naming the site, nothing is sent until the question is, and the AI gets the text, line breaks kept, marked as data from that page with its address, without the user being asked to allow the site. |
| UC-NOTICO-CHAT-006-S02 | P1 | ✅ | Given a selection in a frame from another site; when the user picks "Ask Notico"; then the question carries Chrome's own copy of the selection. |
| UC-NOTICO-CHAT-006-S03 | P1 | ✅ | Given two selections sent before the side panel opened; when the user sends two more, takes two off with their buttons, and asks; then the question carries the others in the order sent; and Backspace in an empty message takes the selections off, the last first. |
| UC-NOTICO-CHAT-006-S04 | P1 | ✅ | Given a question sent with a selection; when the session is reopened and the user clicks the selection in the question; then it still shows, and the current tab goes to the page, to the selected text. |
| UC-NOTICO-CHAT-006-S05 | P2 | ✅ | Given a selection longer than one may be, or more selections than a question may carry in all; when the question is sent; then the AI gets the start of the long one, and the selections up to the limit, and is told what was left out; the question shows only the selections it carried. |
| UC-NOTICO-CHAT-006-S07 | P1 | ✅ | Given "Ask Notico" turned off in Settings; when the user right-clicks selected text, also after an update; then the menu has no "Ask Notico"; and when it is turned on again on another device of the same Chrome profile, the item comes back here. |
| UC-NOTICO-CHAT-006-S08 | P0 | ✅ | Given the user selects text and picks "Ask Notico"; when the panel opens for an account other than the one signed in at the click, or no account was signed in at the click; then the selection does not appear in that panel. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-006-S06 | P1 | ✅ | Given a paragraph selected on a web page in Chrome; when the user picks "Ask Notico" from the context menu and asks what it means; then the side panel opens with the selection in the message box, and the reply explains the paragraph and names the page's address. |
