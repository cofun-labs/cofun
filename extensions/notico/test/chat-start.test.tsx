// The start of a chat (UC-NOTICO-CHAT-001): the suggestions that fit the open page and the mode, as a
// user meets them. The whole panel runs (see panel.ts); besides the screen, the tests look only at
// what the model and Notion were asked.
import '@testing-library/jest-dom/vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeNotionTab, pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const ROADMAP_URL = 'https://app.notion.com/p/2b2b2b2b000040008000000000000020?v=3c3c3c3c000040008000000000000030'

/** A tab showing a database: Notion puts its view in the URL. */
function databaseTab() {
  const tab = new FakeNotionTab(ROADMAP_URL)
  tab.title = 'Roadmap'
  return tab
}

/** A tab on another site. */
function otherSiteTab() {
  const tab = new FakeNotionTab('https://mail.example.com/inbox')
  tab.title = 'Inbox'
  return tab
}

async function openPanel(tab: FakeNotionTab = pageTab()) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
const conversation = () => within(screen.getByRole('main'))

/** The suggestions shown, in order. */
const suggestions = () =>
  within(screen.getByRole('list', { name: 'Suggestions' }))
    .getAllByRole('button')
    .map((b) => b.textContent)

const PAGE_SET = [
  'Summarize "Fixture page"',
  'Turn its action items into a to-do list',
  'Rewrite it to be clearer and shorter',
  'Find pages related to it',
]
const WORKSPACE_SET = ['Find the page about …', "What's in my workspace?", 'Which of my pages mention …']

describe('the start of a chat', () => {
  it('[UC-NOTICO-CHAT-001-S20] on a page, the suggestions name it and offer changes, asking neither the AI nor Notion', async () => {
    const { browser } = await openPanel()

    expect(await screen.findByText('What should we do with this page?')).toBeVisible()
    expect(screen.getByText('Notico can read and edit “Fixture page” and search your workspace.')).toBeVisible()
    expect(suggestions()).toEqual(PAGE_SET)
    expect(browser.ai.calls).toEqual([])
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-NOTICO-CHAT-001-S21] on a database, the suggestions are about its entries, adding one included', async () => {
    const { browser } = await openPanel(databaseTab())

    expect(await screen.findByText('What should we do with this database?')).toBeVisible()
    expect(suggestions()).toEqual([
      'Summarize "Roadmap"',
      'Which entries changed this week?',
      'Count the entries by status',
      'Add an entry for …',
    ])
    // The chip says it is a database too, from the tab's URL alone.
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-NOTICO-CHAT-001-S22] on another site, the suggestions are about the workspace, with a line saying to open a page', async () => {
    await openPanel(otherSiteTab())

    expect(await screen.findByText('What are you looking for?')).toBeVisible()
    expect(suggestions()).toEqual(WORKSPACE_SET)
    expect(
      screen.getByText('Open a Notion page to search your workspace, or to summarize or edit a page.'),
    ).toBeVisible()
  })

  it('[UC-NOTICO-CHAT-001-S23] in Read only, no suggestion asks for a change, on a page or a database', async () => {
    const { browser, user } = await openPanel()
    await screen.findByText('What should we do with this page?')
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))

    expect(await screen.findByText('What do you want to know?')).toBeVisible()
    expect(suggestions()).toEqual([
      'Summarize "Fixture page"',
      'List its action items and who owns them',
      'What questions does it leave open?',
      'Find pages related to it',
    ])

    act(() => browser.tab.navigate(ROADMAP_URL, 'Roadmap'))
    expect(await screen.findByText('Summarize "Roadmap"')).toBeVisible()
    expect(await screen.findByText('What do you want to know?')).toBeVisible()
    expect(suggestions()).toEqual([
      'Summarize "Roadmap"',
      'Which entries changed this week?',
      'Count the entries by status',
    ])
  })

  it('[UC-NOTICO-CHAT-001-S24] taking the page off the question switches to the workspace suggestions, and adding it back to the page ones', async () => {
    const { user } = await openPanel()
    await screen.findByText('What should we do with this page?')

    await user.click(screen.getByRole('button', { name: 'Remove Fixture page' }))
    expect(screen.getByText('What are you looking for?')).toBeVisible()
    expect(suggestions()).toEqual(WORKSPACE_SET)
    // The page is still open in the tab: nothing says to open one.
    expect(screen.queryByText(/^Open a Notion page/)).not.toBeInTheDocument()

    await user.type(composer(), '@fix')
    await user.click(await screen.findByRole('option', { name: /Fixture page/ }))
    expect(screen.getByText('What should we do with this page?')).toBeVisible()
    expect(suggestions()).toEqual(PAGE_SET)
  })

  it('[UC-NOTICO-CHAT-001-S08] a suggestion goes into the message box, not to the model, and can be changed before sending', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'It is a fixture.' })

    await user.click(await screen.findByRole('button', { name: 'Summarize "Fixture page"' }))

    expect(composer()).toHaveValue('Summarize "Fixture page"')
    expect(composer()).toHaveFocus()
    expect(browser.ai.calls).toEqual([])

    await user.keyboard(' in one line{Enter}')

    expect(await conversation().findByText('Summarize "Fixture page" in one line')).toBeVisible()
    await screen.findByRole('button', { name: 'Send' })
    expect(browser.sentToModel().at(-1)!.content).toContain('Summarize "Fixture page" in one line')
    // The suggestions are for a chat with no question yet.
    expect(screen.queryByRole('list', { name: 'Suggestions' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-CHAT-001-S08] a suggestion ending in "…" leaves the cursor where the "…" was', async () => {
    const { user } = await openPanel(otherSiteTab())

    await user.click(await screen.findByRole('button', { name: 'Find the page about …' }))
    expect(composer()).toHaveValue('Find the page about ')
    expect(composer()).toHaveFocus()
    await user.keyboard('the launch')

    expect(composer()).toHaveValue('Find the page about the launch')
  })
})
