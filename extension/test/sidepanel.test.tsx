// The side panel's UI, tested as a user meets it: the whole panel runs (see panel.ts) and the tests
// only type, click, and read what is on screen. Besides the screen they look at the edges alone:
// what the model was sent, and what Notion was asked to do.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
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

  it('[UC-CHAT-001-S08] an example question goes into the message box, not to the model, and can be changed before sending', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'It is a fixture.' })

    await user.click(screen.getByRole('button', { name: 'Summarize this page' }))

    expect(composer()).toHaveValue('Summarize this page')
    expect(browser.ai.calls).toEqual([])

    await user.type(composer(), ' in one line{Enter}')

    expect(await screen.findByText('Summarize this page in one line')).toBeVisible()
    await answered()
    expect(browser.sentToModel().at(-1)!.content).toContain('Summarize this page in one line')
    // The examples are for a session with no question yet.
    expect(screen.queryByRole('button', { name: 'Summarize this page' })).not.toBeInTheDocument()
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

  it('[UC-AGENT-001-S22] a reply says in words what a tool did and on what, and on request the tool, its input, and its result', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )

    await ask(user, 'What does this page say?')
    const answer = await screen.findByText('It is a fixture.')
    await answered()

    // What it did, by the name of the page it read.
    const page = screen.getByText('Fixture page', { selector: 'em' })
    const tool = page.closest('summary')!
    expect(tool).toHaveTextContent(/^Read Fixture page$/)
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    // In the order it happened: the tool ran before the answer.
    expect(comesBefore(tool, answer)).toBe(true)
    // Its own terms stay folded away until the user asks for them.
    expect(screen.getByText('read_page')).not.toBeVisible()

    await user.click(tool)
    expect(screen.getByText('read_page')).toBeVisible()
    expect(screen.getByText('Arguments')).toBeVisible()
    expect(screen.getByText(/"part": 1/)).toBeVisible()
    expect(screen.getByText('Result')).toBeVisible()
    expect(screen.getByText(/Hello \*\*bold\*\*/)).toBeVisible()
  })

  it('[UC-AGENT-001-S22] a tool that failed says so in words, with its error on request', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: 'my notes' }) }] },
      { reply: 'I could not read it.' },
    )

    await ask(user, 'Read my notes')
    await screen.findByText('I could not read it.')
    await answered()

    const tool = screen.getByText("Couldn't read a page")
    expect(tool).toBeVisible()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    await user.click(tool)
    expect(screen.getByText('Error')).toBeVisible()
    expect(screen.getByText('Not a Notion page URL or id: my notes')).toBeVisible()
  })

  it('a call with no arguments shows none', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_selection', arguments: '{}' }] },
      { reply: 'Nothing is selected.' },
    )

    await ask(user, 'What did I select?')
    await answered()

    // The fake tab has nothing selected to give, so the call fails; it has no arguments either way.
    await user.click(screen.getByText("Couldn't read the selection"))
    expect(screen.getByText('get_selection')).toBeVisible()
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument()
  })
})

describe('a formatted reply', () => {
  it('[UC-CHAT-001-S16] the reply is shown formatted, and the question as typed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({
      reply: [
        '## Shopping',
        'You need **milk** and `eggs`, *today*:',
        '1. milk\n   - whole\n2. eggs',
        '- [x] bread',
        '> Buy early.',
        '---',
        '| Item | Count |\n| --- | --- |\n| milk | 2 |',
        '```\nlist = [milk, eggs]\n```',
        'See [the store](https://shop.example.com/list).',
      ].join('\n\n'),
    })

    await ask(user, 'What do I **need**?')
    const heading = await screen.findByRole('heading', { level: 2, name: 'Shopping' })
    await answered()

    // The question stays as the user typed it.
    expect(screen.getByText('What do I **need**?')).toBeVisible()
    expect(heading).toBeVisible()
    expect(screen.getByText('milk', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText('eggs', { selector: 'code' })).toBeVisible()
    expect(screen.getByText('today', { selector: 'em' })).toBeVisible()
    expect(screen.getByRole('separator')).toBeInTheDocument()
    const lists = screen.getAllByRole('list')
    expect(within(lists[0]).getByText('whole')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '' })).toBeChecked()
    expect(screen.getByText('Buy early.').closest('blockquote')).not.toBeNull()
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Count' })).toBeVisible()
    expect(within(table).getByRole('cell', { name: '2' })).toBeVisible()
    expect(screen.getByText('list = [milk, eggs]').closest('pre')).not.toBeNull()
    const link = screen.getByRole('link', { name: 'the store' })
    expect(link).toHaveAttribute('href', 'https://shop.example.com/list')
    expect(link).toHaveAttribute('target', '_blank')
    // None of the Markdown's own characters are left on screen.
    expect(screen.queryByText(/\*\*milk\*\*|## Shopping|\| Item/)).not.toBeInTheDocument()
  })

  it('[UC-CHAT-001-S16] a single line break in a reply stays a line break', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Owner: Ana\nDue: Friday' })

    await ask(user, 'Who owns it?')
    const owner = await screen.findByText(/Owner: Ana/)
    await answered()

    expect(owner.querySelector('br')).not.toBeNull()
  })

  it('a reply still coming in is formatted as it streams, an unclosed code block included', async () => {
    const { browser, user } = await openPanel()
    const resume = pausedReply(browser, 'Run:\n\n```\nnpm test now\n```\n\nThen wait.')

    await ask(user, 'How do I test?')

    // The first two words are in: the code block has started and is not closed yet.
    const code = await screen.findByText(/^npm/)
    expect(code.closest('pre')).not.toBeNull()
    expect(screen.queryByText(/```/)).not.toBeInTheDocument()

    resume()
    expect(await screen.findByText('Then wait.')).toBeVisible()
    await answered()
    expect(screen.getByText('npm test now').closest('pre')).not.toBeNull()
  })

  it('[UC-CHAT-001-S17] HTML in a reply is shown as text, and only web links can be followed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({
      reply: 'Look: <b onclick="alert(1)">bold</b>\n\n[run](javascript:alert(1)) and [mail](mailto:a@example.com)',
    })

    await ask(user, 'Show me')
    await screen.findByText(/Look:/)
    await answered()

    const reply = screen.getByText(/Look:/)
    expect(reply).toHaveTextContent('Look: <b onclick="alert(1)">bold</b>')
    expect(reply.querySelector('b')).toBeNull()
    // Links that are not http or https are shown as their text, not as links.
    expect(screen.getByText('run')).toBeVisible()
    expect(screen.getByText('mail')).toBeVisible()
    expect(screen.queryAllByRole('link')).toEqual([])
  })

  it('[UC-CHAT-001-S18] an image in a reply is not loaded: its description links to it instead', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Here is the chart: ![Sales by month](https://images.example.com/chart.png)' })

    await ask(user, 'Show the chart')
    await screen.findByText(/Here is the chart/)
    await answered()

    expect(within(screen.getByText(/Here is the chart/)).queryByRole('img')).toBeNull()
    // Nothing on the page asks for the image's address.
    expect(document.querySelector('[src*="images.example.com"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sales by month' })).toHaveAttribute(
      'href',
      'https://images.example.com/chart.png',
    )
  })
})

describe('on a tab that is not Notion', () => {
  const INBOX = 'https://mail.example.com/inbox?token=secret'

  /** The side panel open on a tab showing another site. */
  function openElsewhere() {
    const tab = new FakeNotionTab(INBOX)
    tab.title = 'Inbox (3)'
    return openPanel(tab)
  }

  /** What the model was sent as the results of the tools it called. */
  const toolResults = (browser: FakeBrowser) =>
    browser
      .sentToModel()
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)

  it('[UC-PANEL-001-S03] a question is answered, and the model is told only that the tab is not a Notion page', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push({ reply: 'A haiku has three lines.' })

    await ask(user, 'How many lines does a haiku have?')

    expect(await screen.findByText('A haiku has three lines.')).toBeVisible()
    await answered()
    const sent = browser.sentToModel()
    expect(sent.at(-1)!.content).toBe('[The current tab is not a Notion page.]\n\nHow many lines does a haiku have?')
    // Nothing of the tab itself: not its address, and not its title.
    const everything = JSON.stringify(sent)
    expect(everything).not.toContain('mail.example.com')
    expect(everything).not.toContain('Inbox')
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-PANEL-001-S04] a Notion tool fails there, telling the model to send the user to a Notion page, and Notion is not asked', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] },
      { reply: 'Switch to a Notion page and ask again.' },
    )

    await ask(user, 'Summarize this page')

    expect(await screen.findByText('Switch to a Notion page and ask again.')).toBeVisible()
    await answered()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    expect(toolResults(browser)).toEqual([
      expect.stringMatching(/The current tab is not a Notion page.*Tell the user to switch to a Notion page/),
    ])
    // Nothing ran in the tab, so nothing was sent anywhere from it.
    expect(browser.tab.injections).toEqual([])
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-PANEL-001-S05] the model gets the address and title of a tab on another site when it asks for them', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_current_tab', arguments: JSON.stringify({}) }] },
      { reply: 'You are in your inbox.' },
    )

    await ask(user, 'Which site am I on?')

    expect(await screen.findByText('You are in your inbox.')).toBeVisible()
    await answered()
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    expect(toolResults(browser)).toEqual([JSON.stringify({ title: 'Inbox (3)', url: INBOX })])
    // Only what Chrome says about the tab: nothing ran in it.
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-PANEL-001-S06] the model gets the address and title of a Notion tab the same way', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_current_tab', arguments: JSON.stringify({}) }] },
      { reply: 'You are on the fixture page.' },
    )

    await ask(user, 'Give me a link to this tab')

    expect(await screen.findByText('You are on the fixture page.')).toBeVisible()
    await answered()
    expect(toolResults(browser)).toEqual([JSON.stringify({ title: 'Fixture page', url: PAGE_URL })])
    expect(browser.tab.sent).toEqual([])
  })

  // UC-PANEL-001-S07 itself stays ai-e2e: that Chrome keeps the panel open across tabs. This is
  // the panel's part of it.
  it('a conversation started on a Notion page goes on after the user switches to another site', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'It is a fixture.' }, { reply: 'You left Notion.' })

    await ask(user, 'What is this page?')
    await screen.findByText('It is a fixture.')
    await answered()
    browser.tab.url = INBOX
    browser.tab.title = 'Inbox (3)'
    await ask(user, 'And now?')

    expect(await screen.findByText('You left Notion.')).toBeVisible()
    await answered()
    expect(screen.getByText('What is this page?')).toBeVisible()
    expect(
      browser
        .sentToModel()
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    ).toEqual([
      `[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]\n\nWhat is this page?`,
      '[The current tab is not a Notion page.]\n\nAnd now?',
    ])
  })
})

describe('a tool that needs confirmation', () => {
  async function askToTrash() {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ toolCalls: [{ name: 'trash_page', arguments: JSON.stringify({ pages: [NOTE] }) }] })
    await ask(user, 'Delete the old notes')
    const prompt = await screen.findByRole('group', { name: 'Allow this? Move 1 page to the trash' })
    return { browser, user, workspace, prompt }
  }

  it('[UC-AGENT-001-S11] asks first, showing what the tool will do, and runs it only after the user agrees', async () => {
    const { browser, user, workspace, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'The old notes are in the trash.' })

    // The user sees which page would go, by the name Notion has for it now.
    expect(screen.getByText(/Move 1 page to the trash, with everything in it/)).toBeVisible()
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
    expect(screen.queryByRole('group', { name: 'Allow this? Move 1 page to the trash' })).not.toBeInTheDocument()
  })

  it('[UC-AGENT-001-S24] a reply says how many pages it changed, and a change the user declined does not count', async () => {
    const first = await askToTrash()
    first.browser.ai.script.push({ reply: 'Done.' })
    await first.user.click(within(first.prompt).getByRole('button', { name: 'Allow' }))
    await screen.findByText('Done.')
    await answered()
    expect(screen.getByText(/^Changed 1 page · \d+ Notion requests?$/)).toBeVisible()
  })

  it('[UC-AGENT-001-S24] a change the user declined is not counted as changed', async () => {
    const { browser, user, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'Left it.' })
    await user.click(within(prompt).getByRole('button', { name: 'Deny' }))
    await screen.findByText('Left it.')
    await answered()
    expect(screen.queryByText(/Changed \d+ page/)).not.toBeInTheDocument()
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
    const tool = screen.getByText('Fixture page', { selector: 'em' }).closest('summary')!
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

  it('[UC-AGENT-001-S20][UC-AGENT-001-S23] a reply shows how many pages it read and Notion requests it made, also after the session is reopened', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    const made = browser.tab.sent.length
    expect(made).toBeGreaterThan(0)
    const line = `Read 1 page · ${made} Notion request${made === 1 ? '' : 's'}`
    expect(screen.getByText(line)).toBeVisible()

    await browser.openPanel()
    await openSession(user, /What does this page say\?/)

    expect(await screen.findByText(line)).toBeVisible()
    // Showing a saved session asks nothing of Notion.
    expect(browser.tab.sent).toHaveLength(made)
  })

  it('[UC-AGENT-001-S23] a page read twice for a question counts once', async () => {
    const { browser, user } = await openPanel(workspaceTab().tab)
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] },
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: NOTE }) }] },
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: PAGE_URL }) }] },
      { reply: 'Read them.' },
    )

    await ask(user, 'Read this page and its child, then this page again')
    await screen.findByText('Read them.')
    await answered()

    expect(screen.getByText(/^Read 2 pages · \d+ Notion requests?$/)).toBeVisible()
  })

  it('a reply that used no Notion tool has no line under it', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Hello.' })

    await ask(user, 'Hi')
    await screen.findByText('Hello.')
    await answered()

    expect(screen.queryByText(/Notion request|Read \d+ page|Changed \d+ page/)).not.toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: 'Close' }))
    browser.ai.script.push({ reply: 'Hello.' })
    await ask(user, 'Hi')
    await screen.findByText('Hello.')
    await answered()
    expect(browser.sentToModel().map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('the session list closes from its Close button, the Sessions button, or Escape, back to the chat', async () => {
    const { user } = await openPanel()
    const toggle = screen.getByRole('button', { name: 'Sessions' })
    const list = () => screen.queryByRole('dialog', { name: 'Sessions' })

    await user.click(toggle)
    expect(list()).toBeVisible()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()

    await user.click(toggle)
    await user.click(toggle)
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // In the search box, Escape first clears what was typed, then closes the list.
    await user.click(toggle)
    await user.type(screen.getByRole('searchbox'), 'road')
    await user.keyboard('{Escape}')
    expect(list()).toBeVisible()
    await user.clear(screen.getByRole('searchbox'))
    await user.keyboard('{Escape}')
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
    expect(composer()).toBeVisible()
  })

  it('the session list is searched by title, and deleting a session takes a second click', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    const rows = () => screen.queryAllByRole('button', { name: /Fixture page/ }).map((b) => b.textContent)
    await screen.findAllByRole('button', { name: /Fixture page/ })
    // Only search by title: there is no other filter.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'ROADMAP')
    expect(rows()).toEqual([expect.stringMatching(/^What is on the roadmap\?/)])
    await user.clear(screen.getByRole('searchbox'))
    expect(rows()).toHaveLength(2)

    // The first click only asks; the second deletes.
    const [first] = screen.getAllByRole('button', { name: 'Delete session' })
    await user.click(first)
    expect(rows()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(rows()).toEqual([expect.stringMatching(/^What is on the roadmap\?/)]))
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

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('Sign in to use Notico.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    // The chat is gone: nothing to type into, and the conversation is off the screen.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText('Three milestones.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
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
