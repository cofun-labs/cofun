# UC-NOTICO-SESSION-003: Clip a page to Notion

## Behavior

A signed-in user reading a page on any site keeps it in Notion with one click, without the AI: "Clip page to Notion" adds the page as a new page, with a link back, at the end of the one Notion page they chose in Settings. The side panel shows that page in a tab, writes the clip there, and links it. Clip is off until the user turns it on in Settings, which makes a private "Notico Clips" page the target unless they search for another; both settings follow the Chrome profile.

Key constraints:

- A clip sends the page to Notion only: nothing goes to the AI or to Notico's server, and the site is read without asking to allow it.
- A clip never writes twice, and never anywhere else: it is not retried, and when the Notion account signed in can't see the chosen page, nothing is written and the user is told to switch to an account that can.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-003-S01 | P0 | ✅ | Given a chosen Notion page and an article on a site Notico was never allowed to read; when the user picks "Clip page to Notion"; then a new tab shows the chosen page, a page titled with the article's title is created at its end, holding a link to the article and the article's content as formatted text, the side panel links it, and nothing went to the AI or the worker. |
| UC-NOTICO-SESSION-003-S02 | P0 | ✅ | Given the chosen Notion page already open in a tab; when the user picks "Clip page to Notion" on another site; then that tab is shown, not a new one, and the clip is written there; and on selected text the menu keeps only "Ask Notico", at its top level. |
| UC-NOTICO-SESSION-003-S03 | P1 | ✅ | Given the Notion account signed in can't see the chosen page; when the user clips; then nothing is written, and the side panel says to switch to a Notion account that can see it, or choose another page. |
| UC-NOTICO-SESSION-003-S04 | P1 | ✅ | Given Notion turns the clip away, or does not answer whether it was written; when the user clips; then it is not retried, and the user is told to wait, or to look at the chosen page before clipping again. |
| UC-NOTICO-SESSION-003-S05 | P1 | ✅ | Given Clip off, as it starts, and a Notion page open; when the user turns Clip on in Settings' right-click menu section; then a private page "Notico Clips" is made in that workspace and is where clips go, "Clip into" shows under the switch, and the clip item shows in the right-click menu; turning Clip off hides it. |
| UC-NOTICO-SESSION-003-S07 | P1 | ✅ | Given a page titled "Notico Clips" already in the user's Private section; when the user turns Clip on; then that page is where clips go, and no other is made. |
| UC-NOTICO-SESSION-003-S08 | P1 | ✅ | Given Clip on, with a Notion page open; when the user opens "Clip into" and types; then it offers the current page, then the workspace's pages that match, and the one picked is where clips go; off Notion, it says to open a Notion page to search. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-003-S06 | P1 | 🚧 | Given a Notion page chosen in Settings and an article open in Chrome; when the user picks "Clip page to Notion" from the context menu; then the chosen page opens in Notion with a new page at its end that holds the article's headings and paragraphs, and the side panel links it. |
