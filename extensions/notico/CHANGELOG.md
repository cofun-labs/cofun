# Changelog

What changed in each release of Notico, newest first. Each is built for the Chrome Web Store and uploaded there by hand.

## 0.2.0 (2026-11-15)

### Added

- Use your own model: add an OpenRouter key in Settings, check that it works, and pick its models. Switch between Cofun's hosted model and yours from the message box. Answers from your own model spend no credits.
- Buy credits: packs of 1,000, 5,000, 20,000, or 100,000 credits through Stripe's checkout. Nothing renews, and bought credits last a year.
- Each answer from Cofun's model shows what it cost in credits, under it.
- Save a reply, or a whole chat, as a new page under the Notion page you have open.
- Add Notion pages to a question with @ or the + button. The open page shows in the message box as a chip you can remove.
- Read only: switch the message box between Edit and Read only, and Notico only reads and answers until you switch back.
- Each chat gets a short title, shown at the top of the panel.
- Copy a reply from the row under it, and see its details (Notion requests, tokens, model) behind the … button.
- A new chat starts with suggestions that fit the page you have open.
- Click a page a question used to open it in the current tab.
- Usage data: Notico sends usage events that never hold your messages, replies, or anything from your pages. Turn it off in Settings with "Share usage data".

### Changed

- A lighter look: a white panel with neutral greys, your question on a light tint, and the model and send button inside the message box. Button tips show sooner.
- Credits and Settings are two pages of their own in the account menu, with a clearer credit history.
- Leaving a chat while a question is being answered stops it, as Stop does, and the chat keeps what was already done.
- Changing a text property or a title that has formatting Notico can't show now writes your text, and tells you what formatting was dropped so you can add it back in Notion, instead of refusing.
- Text read from Notion is marked to the AI as data, so instructions hidden in a page are less likely to be followed.
- Credits never go below zero: a question that costs more than what is left takes only what is left.
- Asking too much in one minute is turned away with a note to wait a minute.

### Fixed

- Inline equations stay equations when written back, with a line break, a backtick, or spaces at either end.
- After opening a chat from the list, you can type straight away, and the keyboard focus stays put as the credit history loads.
- A page title with a date, a link, a mention, or characters like `*` in it is written back as it was, instead of being turned into formatting.
- The panel names the page an edit or a duplicate was made to, instead of saying "a page".

## 0.1.0 (2026-11-13)

First release.

### Added

- An AI side panel next to Notion: ask in plain words, and it reads, finds, and edits pages for you, showing every change as it makes it.
- Read the open page or any other, long pages included; databases as tables, filtered and sorted; comment threads.
- Find pages by searching the workspace, or by browsing it the way the sidebar does.
- Write: insert, replace, and delete content; create pages with content; change titles and icons.
- Databases: create them, add rows, fill in properties, and add, rename, or remove properties and select options.
- Organize: move and duplicate pages, or move them to Notion's trash (it asks you first, every time).
- Comment on a page or on a block, and mention workspace members by name.
- It knows which page is open and what you selected in it.
- The panel stays open, with your conversation, as you switch tabs. Past conversations are saved, searchable, and can be picked up again.
- Sign in with Google. Nothing to set up on the Notion side: it works through your own Notion tab and session.
- Free credits every week. Your avatar shows how many are left and when they expire; Settings shows daily use and the history of your credits.
