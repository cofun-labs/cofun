# UC-AGENT-001: Ask the AI something that needs a tool

## Behavior

A signed-in user asks the AI something it can only answer with information or actions the extension has, such as what a Notion page says. The extension offers the AI a set of tools. Instead of guessing, the AI asks the extension to run one; the extension runs it and sends back the result, and the AI uses that result to answer. The AI may use several tools, one after another, before it answers.

With each question, the AI is also told which Notion page is open in the current tab, or that the current tab is not a Notion page, so it knows what "this page" means without using a tool. The message box shows that page before the question is sent, as the page it goes with, and follows the user as they switch tabs or move to another page; on another site it shows none. The user can take the page off a question that is about something else: the AI is then told only that no page goes with the question, and the agent can't fall back on the open page for it, so it asks the user which page they mean or searches for one. The page stays off for the chat's next questions until the user goes to another page or starts a new chat. Each question is told the page it went with, and shows that page with the question, also in a reopened session.

Each question gets a bounded number of steps, so a model that keeps calling tools cannot run on forever, and the user can stop the agent at any time.

A question that fails or is stopped leaves no half-finished exchange behind, but what the agent already did stays: each tool it used, and how that ended (its result, a failure, the user declining it, or the user stopping it), remains part of the conversation, so the AI knows about it in the next question. The unfinished reply, and tools the agent had not reached yet, are left out.

The user can always see what the agent did, in the order it happened within the reply: each tool it used, said in words (what it did, and on which page or what it searched for when that is known) and whether it worked, with the tool itself, its input, and what it returned one step further, for whoever wants them.

Each question's use of Notion is visible and bounded, so heavy use of the user's Notion account never goes unnoticed. When a question ends, whether answered, failed, or stopped, the side panel shows what it touched: how many pages and databases it read, how many it changed, and how many requests it made to Notion; a reopened session still shows it. A page counts once however often it was read or changed; searching and listing pages are not reading them; and only changes that were made count, not one that failed, was declined, or was stopped. A question may make only so many Notion requests before the user is asked whether to go on. Until they answer, nothing more is sent to Notion. If they go on, the question may make as many again before they are asked next; if they stop, the question ends there, and the AI is told not to get around the limit.

Key constraints:

- A page the user took off a question is never used for it in place of a page the AI names: not read, and not even named to the AI.
- Tools run in the extension, never on the server. The server only carries the AI's request to run a tool and the result back.
- A tool that moves the user's pages to the trash never runs without the user's confirmation, which they are asked for each time; other changes are made right away, and the side panel shows them. If they decline, the tool does not run and the agent goes on without it; if they stop the agent while it waits, the tool does not run and the question ends.
- Tool definitions, tool requests, and tool results are part of the conversation: the same size limits, credits, and usage records apply, and none of their content is kept by the service. Each round trip to the model is charged credits for what it cost (UC-CHAT-001).

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S01 | P0 | ✅ | Given a signed-in user and a tool the extension offers; when they ask something that needs that tool; then the reply asks the extension to run it, with its arguments, instead of answering. |
| UC-AGENT-001-S02 | P0 | ✅ | Given the result of a tool the extension ran; when it is sent back with the conversation; then the AI answers using it. |
| UC-AGENT-001-S03 | P0 | ✅ | Given a signed-in user who uses tools; when they ask the AI; then nothing in the tool definitions, tool requests, or tool results is kept by the service. |
| UC-AGENT-001-S04 | P0 | ✅ | Given a question that needs a tool; when the user asks it in the side panel; then the tool runs in the extension and the answer uses its result. |
| UC-AGENT-001-S05 | P1 | ✅ | Given a model that keeps calling tools; when the question reaches its step limit; then the agent stops without running more tools and tells the user, and the next question still works. |
| UC-AGENT-001-S09 | P0 | ✅ | Given a tool that needs confirmation; when the user declines it; then it does not run, and the agent continues without it. |
| UC-AGENT-001-S10 | P0 | ✅ | Given a tool that needs confirmation; when the user agrees; then it runs and the answer uses its result. |
| UC-AGENT-001-S12 | P1 | ✅ | Given the agent working on a question; when the user stops it; then the model call and any running tool stop, and the conversation keeps the tools the agent used so far and how each ended, including one stopped while it waited for the user's confirmation, but not the unfinished reply or tools it had not reached yet. |
| UC-AGENT-001-S13 | P1 | ✅ | Given a question that fails after the agent used a tool; when the user asks the next question; then the AI is given that tool's request and result. |
| UC-AGENT-001-S14 | P1 | ✅ | Given a question that is stopped or fails before the agent used any tool; when the user asks the next question; then that question is left out of the conversation. |
| UC-AGENT-001-S15 | P1 | ✅ | Given a Notion page open in the current tab; when the user asks a question, moves to another site, and asks again; then the AI is told with the first question which page was open, and with the second that the current tab is not a Notion page, also when the session is reopened later. |
| UC-AGENT-001-S17 | P1 | ✅ | Given a question that reads a Notion page; when it ends; then the agent reports how many Notion requests it made, and the saved session keeps that count. |
| UC-AGENT-001-S18 | P1 | ✅ | Given a question that has made as many Notion requests as it may; when the next request would go over that; then the agent asks the user and sends nothing more until they answer, and when they go on, the question continues. |
| UC-AGENT-001-S19 | P1 | ✅ | Given a question that has made as many Notion requests as it may; when the user chooses to stop; then nothing more is sent, the question ends, and the AI is told not to work around the limit. |
| UC-AGENT-001-S22 | P1 | ✅ | Given the agent used a tool to answer; when the user looks at the reply; then it says in words what the agent did and, when known, on what, and whether it worked, and, on request, which tool ran, with what input, and what it returned. |
| UC-AGENT-001-S11 | P1 | ✅ | Given a tool that needs confirmation; when the agent wants to use it; then the side panel asks the user first, showing what the tool will do, and the tool runs only after they agree. |
| UC-AGENT-001-S20 | P1 | ✅ | Given the side panel open on a Notion page; when the user asks a question that reads the page; then the reply shows how many Notion requests it made, also after the session is reopened. |
| UC-AGENT-001-S23 | P1 | ✅ | Given a question whose tools read some pages, one of them twice; when it ends; then the reply says how many distinct pages it read, also after the session is reopened. |
| UC-AGENT-001-S24 | P1 | ✅ | Given a question whose tool changes a page; when it ends; then the reply says how many pages it changed, and a change the user declined is not counted. |
| UC-AGENT-001-S25 | P1 | ✅ | Given a Notion page open in the current tab; when the user takes it off the question and asks; then the AI is told that no page goes with the question, not the page's title or address, and a tool that would use the open page when given no page refuses, telling the AI to ask the user which page or to search, without asking anything of Notion. |
| UC-AGENT-001-S26 | P1 | ✅ | Given the side panel open on a Notion page; when the user looks at the message box, moves to another Notion page, and then to another site; then the box shows the open page as the one the question goes with, then the other page, then none, without asking anything of Notion. |
| UC-AGENT-001-S27 | P1 | ✅ | Given a page the user took off the question; when they ask again on the same page; then it stays off; and when they go to another page, or start a new chat, the page open then goes with the next question again. |
| UC-AGENT-001-S28 | P1 | ✅ | Given a question sent with the open page and one sent without it; when the session is reopened later; then the first shows the page it went with, and the second shows none. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-001-S16 | P0 | ✅ | Given the side panel open on a Notion page; when the user asks which page they are on; then the agent answers with the page's title without using a tool. |
| UC-AGENT-001-S29 | P1 | ✅ | Given the side panel open on a Notion page in Chrome; when the user switches to another tab and moves to another page; then the message box shows the page open in the current tab each time, and a question sent after taking it off is answered without reading it. |
| UC-AGENT-001-S21 | P2 | 🚧 | Given a question that has made as many Notion requests as it may; when it needs another; then the side panel asks the user whether to continue, and the question goes on only after they agree. |
