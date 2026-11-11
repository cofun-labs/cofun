# UC-NOTION-008: Change properties and rows

## Behavior

A signed-in user asks the AI to keep a page's or a database's fields up to date: mark tasks done, set due dates or owners' notes from what a page says, rename a page or give it an icon, or add rows to a tracker. The AI makes the changes right away, several pages in one go ("mark these five tasks done" is one change), and the side panel shows each new value and, where the AI has seen it, the old one. A new date replaces the whole date, so when the old one has a reminder, the side panel says the reminder is removed. Values are given as the database shows them, and must fit the property. Text and titles keep their formatting, links, and mentions of pages, people, and dates, and text keeps its line breaks, so a value the AI read and writes back stays as it was. What the AI can't see in such a value (an underline, a comment on the text, a link shown as a preview) stays on the text the AI leaves as it read it, and a change that would remove it from text that stays (a word of it, most of it, or all of it moved elsewhere) is refused; text the AI replaces or removes goes with what was on it. A mention names exactly one workspace member, as in [UC-NOTION-011](UC-NOTION-011-mention-people.md). An option the property doesn't have, a date that isn't one, or a mention that names no one is refused before anything changes, and the AI is told why. Every change is made at once, or none is. A new row goes into the database with its title, its properties, and any content.

Key constraint:

- A value that doesn't fit its property is never written, and nothing else in the same request is either.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-008-S06 | P0 | ✅ | Given rows in a database; when the AI sets properties on several of them; then exactly those rows change, in one change, without the user being asked first. |
| UC-NOTION-008-S02 | P0 | ✅ | Given a value that doesn't fit its property (an unknown option, a date that isn't one, a property that can't be set); when the AI tries to set it; then nothing is written and the AI is told why. |
| UC-NOTION-008-S07 | P1 | ✅ | Given a database; when the AI adds a row with properties and content; then the row is in the database with those values. |
| UC-NOTION-008-S09 | P2 | ✅ | Given a row the AI has seen whose date has a reminder; when the AI sets that date, to the same day or another; then the side panel says the reminder is removed, not that the date is unchanged. |
| UC-NOTION-008-S10 | P1 | ✅ | Given a row with a text property; when the AI sets the text or the title with bold, a link, and mentions of a page, a person, and a date; then Notion shows that formatting, that link, and those mentions, not their marks as text. |
| UC-NOTION-008-S11 | P1 | ✅ | Given a row whose text and title have formatting and mentions, as the AI read them in the database; when the AI writes them back as it read them; then they are stored as they were, and the side panel shows them as unchanged. |
| UC-NOTION-008-S12 | P1 | ✅ | Given a text value or a title that mentions a name no workspace member has; when the AI sets it; then nothing is written, in that row or any other of the request, and the AI is told why. |
| UC-NOTION-008-S13 | P1 | ✅ | Given a text value or a title holding what the AI can't see when it reads it (an underline, a comment on the text, a link shown as a preview); when the AI writes it back as it read it, or changes only other parts of it; then what it couldn't see is still there. |
| UC-NOTION-008-S14 | P1 | ✅ | Given such a value; when the AI's new value still has that text, or a word of it, but would remove what it couldn't see on it; then nothing is written, in that row or any other of the request, and the AI is told what would be lost. |
| UC-NOTION-008-S15 | P2 | ✅ | Given a row whose text has several lines, as the AI read it in the database; when the AI writes it back as it read it; then it is stored with its line breaks, and the side panel shows it as unchanged. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTION-008-S08 | P0 | ✅ | Given the side panel open on a task database; when the user asks to mark some of the tasks done; then those rows show done after a reload, without the user being asked, and the others are unchanged. |
