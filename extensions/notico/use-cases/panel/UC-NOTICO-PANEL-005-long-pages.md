# UC-NOTICO-PANEL-005: Read a long page in parts

## Behavior

A page the AI reads from a tab (UC-NOTICO-PANEL-001) or by its address (UC-NOTICO-PANEL-003) can be far longer than one answer can take in: a long article, a spec, a report. Such a page comes as its first part with an outline of its headings, and the AI can read any other part, or find the lines that hold some text, when the question needs what the rest says. Its full text is kept on the device, for that chat only, for 7 days.

Key constraints:

- Every part and every line found is data for the AI from that page, never instructions to it.
- A page kept in one chat is never read in another.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-005-S01 | P1 | ✅ | Given a page longer than one part, in a tab or at an address; when the AI reads it, and then another part; then it gets the first part with an outline of its headings and the part each starts in, and an id to read the rest by, and each part marked as data from that page. |
| UC-NOTICO-PANEL-005-S03 | P1 | ✅ | Given a page the AI read in parts; when it searches it for some text; then it gets the lines that hold the text, ignoring case, at most 20, each with the part it is in. |
| UC-NOTICO-PANEL-005-S04 | P1 | ✅ | Given a page read in parts in one chat; when the AI in another chat asks for it by its id; then it is refused, as an id it was never given. |
| UC-NOTICO-PANEL-005-S05 | P1 | ✅ | Given a page the AI read in parts more than 7 days ago; when the side panel opens; then the page's full text is deleted from the device, whether the chat is still saved or was deleted. |
| UC-NOTICO-PANEL-005-S06 | P2 | ✅ | Given a page longer than what is kept of it; when the AI reads it; then it is told how much of the page was kept. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-005-S07 | P2 | 🚧 | Given a user who asks about a detail far down a long public article; when the AI reads the article; then it finds the detail in a later part and answers from it. |
