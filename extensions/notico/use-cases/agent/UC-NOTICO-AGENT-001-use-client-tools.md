# UC-NOTICO-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with what the extension has, such as what a Notion page says. The AI asks the extension to run tools, one after another if needed, and answers from their results. Each question is told which Notion page it goes with: the one open in the current tab, unless the user takes it off.

The user can stop the agent at any time, and a question asks the user before it goes past a number of Notion requests. However it ends, answered, failed, or stopped, the reply shows what the agent did and how much of Notion it read and changed: searching and listing pages are not reading them, and only changes that were made count, not one that failed, was declined, or was stopped.

Key constraints:

- A page the user took off a question is never used for it in place of a page the AI names: not read, and not even named to the AI.
- A tool that moves the user's pages to the trash never runs without the user's confirmation, which they are asked for each time; other changes are made right away, and the side panel shows them. In Read only (UC-NOTICO-AGENT-003) no tool that changes data is offered at all. If they decline, the tool does not run and the agent goes on without it; if they stop the agent while it waits, the tool does not run and the question ends.
- Tool definitions, tool requests, and tool results are part of the conversation: the same size limits, credits, and usage records apply, and none of their content is kept by the service (UC-COFUN-CHAT-001). Each round trip to the model is charged credits for what it cost (UC-NOTICO-CHAT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-001-S09 | P0 | ✅ | Given a tool that needs confirmation; when the agent wants to use it; then the side panel asks the user first, showing what the tool will do; when they decline, it does not run and the agent continues without it; when they agree, it runs and the answer uses its result; and when they stop the question while it asks, the tool does not run, the question ends, and the conversation keeps the call as stopped. |
| UC-NOTICO-AGENT-001-S32 | P1 | ✅ | Given a question in which the agent already changed something; when the user stops it; then the reply says that changes may already have been made, and to check before asking again; a question stopped before any change says nothing of one. |
| UC-NOTICO-AGENT-001-S15 | P1 | ✅ | Given a Notion page open in the current tab; when the user asks a question, moves to another site, and asks again; then the AI is told with the first question which page was open, and with the second that the current tab is not a Notion page, also when the session is reopened later. |
| UC-NOTICO-AGENT-001-S17 | P1 | ✅ | Given a question that reads a Notion page; when it ends; then the agent reports how many Notion requests it made, and the saved session keeps that count. |
| UC-NOTICO-AGENT-001-S22 | P1 | ✅ | Given the agent used a tool to answer; when the user looks at the reply; then it says in words what the agent did and, when known, on what, and whether it worked, and, on request, which tool ran, with what input, and what it returned. |
| UC-NOTICO-AGENT-001-S23 | P1 | ✅ | Given a question whose tools read some pages, one of them twice, and change a page; when it ends; then the reply says how many distinct pages it read and how many it changed, not counting a change the user declined, also after the session is reopened. |
| UC-NOTICO-AGENT-001-S25 | P1 | ✅ | Given the side panel open on a Notion page; when the user asks a question that reads the page and opens the reply's details; then they show what it read and changed, how many Notion requests it sent, the model that answered, and the tokens it used, also after the session is reopened; nothing under the reply counts the requests. |
| UC-NOTICO-AGENT-001-S26 | P1 | ✅ | Given a Notion page open in the current tab; when the user takes it off the question and asks; then the AI is told that no page goes with the question, not the page's title or address, and a tool that would use the open page when given no page refuses, telling the AI to ask the user which page or to search, without asking anything of Notion. |
| UC-NOTICO-AGENT-001-S27 | P1 | ✅ | Given the side panel open on a Notion page; when the user looks at the message box, moves to another Notion page, and then to another site; then the box shows the open page as the one the question goes with, then the other page, then none, without asking anything of Notion. |
| UC-NOTICO-AGENT-001-S28 | P1 | ✅ | Given a page the user took off the question; when they ask again on the same page, also after a visit to another site; then it stays off; when they go to another page, or start a new chat, the page open then goes with the next question again; and when the session is reopened, each question shows the page it went with, or none. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-001-S16 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks which page they are on; then the agent answers with the page's title without using a tool. |
| UC-NOTICO-AGENT-001-S30 | P1 | ✅ | Given the side panel open on a Notion page in Chrome; when the user switches to another tab and moves to another page; then the message box shows the page open in the current tab each time, and a question sent after taking it off is answered without reading it. |
