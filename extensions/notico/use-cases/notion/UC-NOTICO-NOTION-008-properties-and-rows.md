# UC-NOTICO-NOTION-008: Change properties and rows

## Behavior

A signed-in user asks the AI to keep a page's or a database's fields up to date: mark tasks done, set due dates or owners, rename a page, or add rows to a tracker. The AI makes the changes right away, several pages in one change, and the side panel shows each new value. Values are given as the database shows them and must fit the property. Text keeps its formatting, links, and mentions, and a value the AI writes back as it read it stays as it was, even what the AI couldn't see in it.

Key constraint:

- A value that doesn't fit its property is never written, and nothing else in the same request is either.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-008-S06 | P0 | ✅ | Given rows in a database; when the AI sets properties on several of them; then exactly those rows change, in one change, without the user being asked first. |
| UC-NOTICO-NOTION-008-S02 | P0 | ✅ | Given a value that doesn't fit its property (an unknown option, a date that isn't one, a property that can't be set); when the AI tries to set it; then nothing is written and the AI is told why. |
| UC-NOTICO-NOTION-008-S07 | P1 | ✅ | Given a database; when the AI adds a row with properties and content; then the row is in the database with those values. |
| UC-NOTICO-NOTION-008-S09 | P2 | ✅ | Given a row the AI has seen whose date has a reminder; when the AI sets that date, to the same day or another; then the side panel says the reminder is removed, not that the date is unchanged. |
| UC-NOTICO-NOTION-008-S10 | P1 | ✅ | Given a row with a text property; when the AI sets the text or the title with bold, a link, and mentions of a page, a person, and a date; then Notion shows that formatting, that link, and those mentions, not their marks as text. |
| UC-NOTICO-NOTION-008-S11 | P1 | ✅ | Given a row whose text and title have formatting, mentions, or several lines, as the AI read them in the database, or a page whose title has characters Markdown would read as formatting, as a list or search of pages shows it; when the AI writes them back as it read them; then they are stored as they were, and the side panel shows them as unchanged. |
| UC-NOTICO-NOTION-008-S12 | P1 | ✅ | Given a text value or a title that mentions a name no workspace member has; when the AI sets it; then nothing is written, in that row or any other of the request, and the AI is told why. |
| UC-NOTICO-NOTION-008-S13 | P1 | ✅ | Given a text value or a title holding what the AI can't see when it reads it (an underline, a comment on the text, a link shown as a preview); when the AI writes it back as it read it; then what it couldn't see is still there; and when it writes a different value, that value is written as the AI gave it, and the AI is told what it couldn't see was lost, and on which text. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-008-S08 | P0 | ✅ | Given the side panel open on a task database; when the user asks to mark some of the tasks done; then those rows show done after a reload, without the user being asked, and the others are unchanged. |
