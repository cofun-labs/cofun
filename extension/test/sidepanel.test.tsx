// The side panel's UI, tested as a user meets it: the whole panel runs (see panel.ts) and the tests
// only type, click, and read what is on screen. Besides the screen they look at the edges alone:
// what the model was sent, and what Notion was asked to do.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

/** A browser signed in to Notico, with the side panel open on `tab`. */
async function openPanel(tab: FakeNotionTab = pageTab()) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })

async function ask(user: UserEvent, question: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** The question has ended: the composer offers Send again. */
const answered = () => screen.findByRole('button', { name: 'Send' })

/**
 * A model reply that stops partway until `resume` is called. The fake model streams each word as an
 * event of about 60 bytes, so it stops after the first two words.
 */
function pausedReply(browser: FakeBrowser, reply: string, after = 150) {
  let resume!: () => void
  browser.ai.pause = { after, until: new Promise<void>((resolve) => (resume = resolve)) }
  browser.ai.script.push({ reply })
  return resume
}

const comesBefore = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

const NOTE = '2c2c2c2c-0000-4000-8000-000000000021'

/** A workspace whose open page has one child page, "Old notes". */
function workspaceTab() {
  const page = (id: string, title: string, parent: string, content: string[] = []) => ({
    id,
    type: 'page',
    properties: { title: [[title]] },
    parent_id: parent,
    parent_table: 'block',
    content,
  })
  const workspace = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      { ...page(PAGE, 'Fixture page', SPACE, [NOTE]), parent_table: 'space' },
      page(NOTE, 'Old notes', PAGE),
    ],
    SPACE,
  )
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = workspace
  return { tab, workspace }
}

describe('asking the AI', () => {
  it('[UC-CHAT-001-S03] the sent message appears and the reply streams in below it', async () => {
    const { browser, user } = await openPanel()
    // The model has written its first words and is still writing.
    const resume = pausedReply(browser, 'The roadmap has three milestones')

    await user.type(composer(), 'What is on the roadmap?{Enter}')

    const question = await screen.findByText('What is on the roadmap?')
    const reply = await screen.findByText(/^The roadmap/)
    expect(reply).not.toHaveTextContent('milestones')
    expect(comesBefore(question, reply)).toBe(true)
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()

    resume()
    expect(await screen.findByText('The roadmap has three milestones')).toBeVisible()
    await answered()
  })

  // UC-AGENT-001-S16 itself stays ai-e2e: whether the model answers from the note, without a tool, is its
  // own judgment. This is the panel's part of it.
  it('a question goes to the model with a note naming the open page, and the panel shows only what the user typed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'You are on "Fixture page".' })

    await ask(user, 'Which page am I on?')

    expect(await screen.findByText('You are on "Fixture page".')).toBeVisible()
    await answered()
    const sent = browser.sentToModel().at(-1)!
    expect(sent.content).toContain(`[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]`)
    expect(sent.content).toContain('Which page am I on?')
    // What the user typed is shown, not the note the extension added.
    expect(screen.queryByText(/The Notion page open in the current tab/)).not.toBeInTheDocument()
    // Telling the model which page is open asks nothing of Notion.
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-AGENT-001-S08] a reply shows the tool that ran, its input, that it worked, and on request its result', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )

    await ask(user, 'What does this page say?')
    const answer = await screen.findByText('It is a fixture.')
    await answered()

    const tool = screen.getByText('read_page')
    expect(tool).toBeVisible()
    expect(screen.getByText('part: 1')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    // In the order it happened: the tool ran before the answer.
    expect(comesBefore(tool, answer)).toBe(true)

    // What it returned stays folded away until the user asks for it.
    expect(screen.getByText('Result')).not.toBeVisible()
    await user.click(tool)
    expect(screen.getByText('Result')).toBeVisible()
    expect(screen.getByText(/Hello \*\*bold\*\*/)).toBeVisible()
  })

  it('[UC-AGENT-001-S08] a tool that failed shows as failed, with its error on request', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: 'my notes' }) }] },
      { reply: 'I could not read it.' },
    )

    await ask(user, 'Read my notes')
    await screen.findByText('I could not read it.')
    await answered()

    expect(screen.getByText('page: "my notes"')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    await user.click(screen.getByText('read_page'))
    expect(screen.getByText('Error')).toBeVisible()
    expect(screen.getByText('Not a Notion page URL or id: my notes')).toBeVisible()
  })
})

describe('a tool that needs confirmation', () => {
  async function askToTrash() {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ toolCalls: [{ name: 'trash_page', arguments: JSON.stringify({ pages: [NOTE] }) }] })
    await ask(user, 'Delete the old notes')
    const prompt = await screen.findByRole('group', { name: 'Allow trash_page to run?' })
    return { browser, user, workspace, prompt }
  }

  it('[UC-AGENT-001-S11] asks first, showing what the tool will do, and runs it only after the user agrees', async () => {
    const { browser, user, workspace, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'The old notes are in the trash.' })

    // The user sees which page would go, by the name Notion has for it now.
    expect(screen.getByText(/Move 1 page to the trash/)).toBeVisible()
    expect(screen.getByText(/"Old notes"/)).toBeVisible()
    expect(screen.getByRole('img', { name: 'Waiting for your OK' })).toBeVisible()
    // Nothing has changed, and the model has not been asked again.
    expect(workspace.transactions).toEqual([])
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: true })
    expect(browser.ai.calls).toHaveLength(1)

    await user.click(within(prompt).getByRole('button', { name: 'Allow' }))

    expect(await screen.findByText('The old notes are in the trash.')).toBeVisible()
    await answered()
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: false })
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Allow trash_page to run?' })).not.toBeInTheDocument()
  })

  it('[UC-AGENT-001-S11] does not run the tool when the user declines, and the agent goes on without it', async () => {
    const { browser, user, workspace, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'I left the old notes where they are.' })

    await user.click(within(prompt).getByRole('button', { name: 'Deny' }))

    expect(await screen.findByText('I left the old notes where they are.')).toBeVisible()
    await answered()
    expect(workspace.transactions).toEqual([])
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: true })
    expect(screen.getByRole('img', { name: 'Declined' })).toBeVisible()
    expect(browser.sentToModel().at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') })
  })
})

describe('sessions', () => {
  /** Asks a question the agent answers by reading the open page. */
  async function askAboutPage(browser: FakeBrowser, user: UserEvent) {
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )
    await ask(user, 'What does this page say?')
    await screen.findByText('It is a fixture.')
    await answered()
  }

  async function openSession(user: UserEvent, title: RegExp) {
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await user.click(await screen.findByRole('button', { name: title }))
  }

  it('[UC-SESSION-001-S06] a reopened session shows its tool calls, and a follow-up continues it', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    // The next day, the side panel is opened again.
    vi.setSystemTime(new Date(START.getTime() + 24 * 60 * 60 * 1000))
    await browser.openPanel()
    expect(screen.queryByText('What does this page say?')).not.toBeInTheDocument()
    await openSession(user, /What does this page say\?/)

    const question = await screen.findByText('What does this page say?')
    const tool = screen.getByText('read_page')
    const answer = screen.getByText('It is a fixture.')
    expect(comesBefore(question, tool)).toBe(true)
    expect(comesBefore(tool, answer)).toBe(true)
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    await user.click(tool)
    expect(screen.getByText(/Hello \*\*bold\*\*/)).toBeVisible()

    browser.ai.script.push({ reply: 'Its first heading is "Fixture page".' })
    await ask(user, 'And its first heading?')

    expect(await screen.findByText('Its first heading is "Fixture page".')).toBeVisible()
    await answered()
    // The model got the earlier conversation, with the tool call and what it returned, then the new question.
    expect(browser.sentToModel()).toMatchObject([
      { role: 'system' },
      { role: 'user', content: expect.stringContaining('What does this page say?') },
      { role: 'assistant', tool_calls: [{ function: { name: 'read_page' } }] },
      { role: 'tool', content: expect.stringContaining('Hello **bold**') },
      { role: 'assistant', content: expect.stringContaining('It is a fixture.') },
      { role: 'user', content: expect.stringContaining('And its first heading?') },
    ])
  })

  it('[UC-AGENT-001-S20] a reply shows how many Notion requests it made, also after the session is reopened', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    const made = browser.tab.sent.length
    expect(made).toBeGreaterThan(0)
    expect(screen.getByText(`Notion requests: ${made}`)).toBeVisible()

    await browser.openPanel()
    await openSession(user, /What does this page say\?/)

    expect(await screen.findByText(`Notion requests: ${made}`)).toBeVisible()
    // Showing a saved session asks nothing of Notion.
    expect(browser.tab.sent).toHaveLength(made)
  })

  it('[UC-SESSION-001-S07] opening the side panel starts a new, empty session, with the earlier ones in the list', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()

    vi.setSystemTime(new Date(START.getTime() + 120_000))
    await browser.openPanel()

    expect(screen.getByText('Ask anything to get started.')).toBeVisible()
    expect(screen.queryByText('Who owns the launch?')).not.toBeInTheDocument()
    expect(composer()).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    const sessions = await screen.findAllByRole('button', { name: /Fixture page/ })
    // Most recently used first, each with its first question and the page it started on.
    expect(sessions.map((s) => s.textContent)).toEqual([
      expect.stringMatching(/^Who owns the launch\?Fixture page/),
      expect.stringMatching(/^What is on the roadmap\?Fixture page/),
    ])

    // A question asked now starts a session of its own: nothing of the earlier ones goes to the model.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    browser.ai.script.push({ reply: 'Hello.' })
    await ask(user, 'Hi')
    await screen.findByText('Hello.')
    await answered()
    expect(browser.sentToModel().map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('[UC-SESSION-001-S08] switching sessions stops a reply still coming in, and it lands in neither session', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    const resume = pausedReply(browser, 'Alice owns the launch')
    await ask(user, 'Who owns the launch?')
    await screen.findByText(/^Alice owns/)

    await openSession(user, /What is on the roadmap\?/)

    // The earlier session is on screen, ready for a question, without the reply that was coming in.
    expect(await screen.findByText('Three milestones.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible()
    expect(screen.queryByText(/Alice owns/)).not.toBeInTheDocument()
    expect(screen.queryByText('Who owns the launch?')).not.toBeInTheDocument()

    // Whatever the model still writes for the stopped question goes nowhere.
    resume()
    browser.ai.pause = undefined
    browser.ai.script.push({ reply: 'In March.' })
    await ask(user, 'When is the first one?')
    expect(await screen.findByText('In March.')).toBeVisible()
    await answered()
    expect(screen.queryByText(/Alice owns/)).not.toBeInTheDocument()
    expect(JSON.stringify(browser.sentToModel())).not.toContain('launch')

    // The stopped question left no session behind either.
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    expect(await screen.findByRole('button', { name: /What is on the roadmap\?/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Who owns the launch\?/ })).not.toBeInTheDocument()
  })
})

describe('signing in and out', () => {
  it('[UC-AUTH-001-S04] signing out from the side panel returns it to the sign-in screen', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Open user menu' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('Sign in to use Notico.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    // The chat is gone: nothing to type into, and the conversation is off the screen.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText('Three milestones.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open user menu' })).not.toBeInTheDocument()
  })

  it('a signed-out panel offers only to sign in, on the sign-in page', async () => {
    const browser = await FakeBrowser.start(pageTab())
    await browser.openPanel()
    const user = userEvent.setup()

    expect(screen.getByText('Sign in to use Notico.')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(browser.openedTabs).toEqual(['https://copilot.test/login'])
    expect(browser.ai.calls).toEqual([])
  })
})
