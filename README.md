<h1 align="center">Copilot for Notion</h1>

<p align="center">
  An AI side panel for Chrome that reads and edits your Notion pages with you.<br />
  Ask in plain words; it finds the pages, does the work, and shows you every change.
</p>

<p align="center">
  <img src="docs/assets/demo.svg" alt="You ask in the side panel, Copilot reads the open page, then adds an Action items section to it" width="880" />
</p>

<p align="center"><sub>An illustration of the side panel, not a screenshot.</sub></p>

## What it can do

| | |
|---|---|
| **Read** | The page you have open or any other page, long pages included. Databases as tables, filtered and sorted. Comment threads. |
| **Find** | Search your workspace, or browse pages the way the sidebar lists them, then read what it finds. |
| **Write** | Insert, replace, and delete content in a page. Create new pages with content. Change titles and icons. |
| **Databases** | Create databases, add rows, fill in properties, and add, rename, or remove properties and select options. |
| **Organize** | Move pages under another page, duplicate them, or move them to Notion's trash (it asks you first). |
| **Collaborate** | Add comments on a page or on a block, and mention workspace members by name. |
| **Stay in context** | It knows which page is open and what you selected in it. Past conversations are saved, searchable, and can be picked up again. |

## Get started

1. **Install** the extension from the Chrome Web Store. _(Not published yet; the link will be here.)_
2. **Open a Notion page** and click the Copilot for Notion icon in Chrome's toolbar. The side panel opens next to the page.
3. **Sign in.** The panel opens a sign-in page in a new tab (Google is supported); once you're signed in, the panel picks it up.
4. **Ask.** A few things to try:
   - _Summarize this page in five bullet points._
   - _Turn the notes on this page into a list of action items._
   - _Find our onboarding docs and tell me what's out of date._
   - _Which tasks in this database are overdue? Add a comment on each one._
   - _Create a page for next week's meeting, with the agenda from the last one._
   - Select some text in the page, then: _Rewrite this to be shorter._

There is nothing to connect on the Notion side: no integration to create, no token to paste.

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="The side panel reads and edits pages through your own Notion tab, and sends your question to the Copilot server, which passes it to an AI model" width="880" />
</p>

- **It works as you, in your own Notion tab.** Pages are read and changed from inside the Notion tab you already have open, with the session you're already signed in with. Copilot can reach what you can reach, and nothing else. The trade-off: it uses the same internal API as Notion's own web app, which is not a public API and may change.
- **The server never talks to Notion.** It checks who you are and passes the conversation to the model. The work on your pages happens in your browser.
- **It is careful with your Notion account.** If Notion asks it to slow down, or answers with something it doesn't understand, it stops and tells you instead of pushing on or working around it.

## Privacy and safety

**What leaves your browser.** Your questions, and the content of the pages Copilot reads to answer them, go to the Copilot server and on to the AI model. The server doesn't keep them: for each request it records who asked, sizes, token counts, and the outcome, never the text of a prompt or a reply.

**What stays on your device.** Conversations are saved in Chrome on your device, per account, and kept after you sign out so you can pick up again. They are not encrypted: anyone who can use your Chrome profile can read them, including the page content Copilot read.

**It edits without asking first.** Copilot edits pages, creates pages and rows, changes properties, adds comments, and moves and duplicates pages as soon as it decides to. Moving pages to the trash is the one thing it asks you about, every time. Each change is shown in the side panel as it happens, and Notion's page history can undo edits.

**Be careful with pages you don't control.** Copilot reads text written by other people: shared pages, guest content, search results. An instruction hidden in that text could make it act as you without anyone being asked, for example by copying something private into a page or a comment that others can read. Comments and mentions also notify people. Page history can undo a change, but not what someone read in the meantime. [More on this trade-off](docs/architecture.md#writes-without-approval).

Copilot for Notion is an independent open-source project. It is not made or endorsed by Notion.

## For developers

- [Architecture](docs/architecture.md): how it is built, the technical choices and why, the sign-in flow, and the code layout.
- [Development](docs/development.md): build and load the extension, run the checks, and deploy your own worker.
- [AGENTS.md](AGENTS.md): the issue → PR → review → merge workflow and coding rules.
- [BDD](docs/bdd.md) and [use cases](docs/use-cases): the product behavior contract and how it is tested.
