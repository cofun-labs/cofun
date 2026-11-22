# UC-WEBCO-CHAT-001: Ask from the side panel

## Behavior

A signed-in user asks a question and reads the AI’s reply as it streams. They can stop a reply while it is being written. Whatever the model writes, a reply loads nothing and opens nothing but web pages. A new chat suggests questions that fit the current tab.

## Scenarios

### api-test

| ID                    | Priority | Status | Scenario                                                                                                                                                                                                                                                                                |
| --------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-WEBCO-CHAT-001-S03 | P0       | ✅     | Given a signed-in user; when they send a question; then their message appears and the reply streams beneath it.                                                                                                                                                                         |
| UC-WEBCO-CHAT-001-S04 | P1       | ✅     | Given a reply is streaming; when the user clicks Stop; then the reply stops and the composer is available for another question.                                                                                                                                                         |
| UC-WEBCO-CHAT-001-S05 | P2       | ✅     | Given a new chat; when the panel shows it; then its suggestions fit the current tab: on a YouTube video, summarizing it and listing its moments with their times; on another page Webco can read, reading that page; and otherwise only searching the web; and the AI is asked nothing. |
| UC-WEBCO-CHAT-001-S17 | P0 | ✅ | Given a reply with HTML and non-web links in it; when it is shown; then the HTML is shown as text, and only its web links can be followed. |
| UC-WEBCO-CHAT-001-S18 | P0 | ✅ | Given a reply with an image in it; when it is shown; then the image is not loaded, and its description links to it instead. |

### ai-e2e

(none)
