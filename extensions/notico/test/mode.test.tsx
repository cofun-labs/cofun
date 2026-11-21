// Edit and Read only (UC-NOTICO-AGENT-003), as a user switches between them from the message box. Besides
// the screen, the tests look at the edges: what the model was offered and told, and what Notion was
// asked to change.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const NOTE = '2c2c2c2c-0000-4000-8000-000000000021'
const hex = (id: string) => id.replaceAll('-', '')

/** A tab on a workspace whose open page has one child page, "Old notes". */
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

async function openPanel(tab: FakeNotionTab, signedInAs = 'user_alice') {
  const browser = await FakeBrowser.start(tab, { signedInAs })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
const conversation = () => within(screen.getByRole('main'))
const answered = () => screen.findByRole('button', { name: 'Send' })

async function ask(user: UserEvent, question: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** The model renames "Old notes", whatever it was offered. */
const RENAME = {
  toolCalls: [{ name: 'update_pages', arguments: JSON.stringify({ pages: [{ page: hex(NOTE), title: 'Archive' }] }) }],
}

/** The tools the model was offered with its call `n`, by name. */
function offered(browser: FakeBrowser, n: number): string[] {
  const tools = browser.ai.calls[n].inputs.tools as { function: { name: string } }[]
  return tools.map((t) => t.function.name)
}

/** What the user's latest question said, as the model got it. */
const lastQuestion = (browser: FakeBrowser) => browser.sentToModel().findLast((m) => m.role === 'user')!.content!

const READING = [
  'read_page',
  'search_pages',
  'get_selection',
  'query_database',
  'list_pages',
  'read_comments',
  'get_current_tab',
  'read_current_tab',
  'read_tab',
  'read_web_page',
  'render_web_page',
  'search_web',
  'read_result',
  'search_result',
]
const CHANGING = [
  'edit_page',
  'create_page',
  'update_pages',
  'create_database',
  'update_database_schema',
  'move_page',
  'duplicate_page',
  'trash_page',
  'undo_changes',
  'add_comment',
]

describe('Read only', () => {
  it('[UC-NOTICO-AGENT-003-S01] the model is offered the same tools as in Edit, is told how to switch, and nothing changes when it asks', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
    // The message box says which mode the next question is asked in.
    expect(screen.getByRole('button', { name: 'Mode: Read only' })).toHaveAccessibleDescription(
      "Read only: won't change pages",
    )
    expect(composer()).toHaveAttribute('placeholder', expect.stringMatching(/^Ask without changing anything/))

    browser.ai.script.push(RENAME, { reply: "I can't make changes in Read only." })
    await ask(user, 'Rename Old notes to Archive')
    expect(await screen.findByText("I can't make changes in Read only.")).toBeVisible()
    await answered()

    // Every tool, in the order Edit offers them: the same start of every request keeps the prompt cache.
    expect(offered(browser, 0).sort()).toEqual([...READING, ...CHANGING].sort())
    expect(lastQuestion(browser)).toMatch(/^\[Read only: .*switch to Edit with the mode button/)
    // The call the model made anyway did not run, and the model was told why.
    expect(browser.sentToModel().at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringMatching(/^Not run: this question is in Read only/),
    })
    expect(conversation().getByRole('img', { name: 'Not run' })).toBeVisible()
    expect(workspace.transactions).toEqual([])
    expect(workspace.records.get(NOTE)).toMatchObject({ properties: { title: [['Old notes']] } })
    expect(conversation().getByText('Read only')).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-003-S02] a user who has not chosen a mode is in Edit, and the agent makes the change', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    expect(screen.getByRole('button', { name: 'Mode: Edit' })).toHaveAccessibleDescription('Edit: can change pages')
    expect(composer()).toHaveAttribute('placeholder', expect.stringMatching(/^Ask something/))

    browser.ai.script.push(RENAME, { reply: 'Renamed it.' })
    await ask(user, 'Rename Old notes to Archive')
    expect(await screen.findByText('Renamed it.')).toBeVisible()
    await answered()

    expect(offered(browser, 0)).toEqual(expect.arrayContaining([...READING, ...CHANGING]))
    expect(lastQuestion(browser)).not.toMatch(/Read only|\[Edit/)
    expect(workspace.records.get(NOTE)).toMatchObject({ properties: { title: [['Archive']] } })
    expect(conversation().queryByText('Read only')).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-AGENT-001-S32] a reply stopped after a change says that changes may already have been made', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    // The page is renamed; the answer after it stops partway, until the user stops it.
    const words = Array.from({ length: 100 }, (_, n) => `word${n}`).join(' ')
    browser.ai.pause = { after: 4000, until: new Promise<void>(() => {}) }
    browser.ai.script.push(RENAME, { reply: words })

    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText(/^word0/)
    expect(workspace.records.get(NOTE)).toMatchObject({ properties: { title: [['Archive']] } })
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await answered()
    expect(
      conversation().getByText('Some changes in this question may already have been made: check before asking again.'),
    ).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-003-S03] a question running in Read only stays so after a switch to Edit, and the next one can change pages', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))

    // The model is still writing its first reply when the user switches.
    let resume!: () => void
    browser.ai.pause = { after: 150, until: new Promise<void>((resolve) => (resume = resolve)) }
    // It asks for a change only after the switch, in the same question.
    browser.ai.script.push(
      { reply: 'Looking at it, one moment please.', toolCalls: RENAME.toolCalls },
      { reply: "I can't rename it in Read only." },
      RENAME,
      { reply: 'Renamed it.' },
    )
    await ask(user, 'What is under this page?')
    await screen.findByRole('button', { name: 'Stop' })
    await user.click(screen.getByRole('button', { name: 'Mode: Read only' }))
    expect(screen.getByRole('button', { name: 'Mode: Edit' })).toBeVisible()
    resume()
    await screen.findByText("I can't rename it in Read only.")
    await answered()
    expect(conversation().getByText('Read only')).toBeVisible()
    // The question stayed in Read only: its call was not run, and nothing changed.
    expect(conversation().getByRole('img', { name: 'Not run' })).toBeVisible()
    expect(workspace.transactions).toEqual([])

    browser.ai.pause = undefined
    await ask(user, 'Rename Old notes to Archive')
    expect(await screen.findByText('Renamed it.')).toBeVisible()
    await answered()
    // The same tools, in the same order, as the question in Read only was offered.
    expect(offered(browser, 2)).toEqual(offered(browser, 0))
    // The conversation goes on, and the model is told that changes are possible again.
    expect(browser.sentToModel().some((m) => m.content?.includes('Looking at it'))).toBe(true)
    expect(lastQuestion(browser)).toMatch(/^\[Edit: /)
    expect(workspace.records.get(NOTE)).toMatchObject({ properties: { title: [['Archive']] } })
    // Only the first question says it was asked in Read only.
    expect(conversation().getAllByText('Read only')).toHaveLength(1)
  })

  it('[UC-NOTICO-AGENT-003-S04] Read only is kept for the account when the panel opens again, and another account starts in Edit', async () => {
    const { tab } = workspaceTab()
    {
      const { browser, user } = await openPanel(tab)
      await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
      await browser.openPanel()
      expect(await screen.findByRole('button', { name: 'Mode: Read only' })).toBeVisible()
      browser.ai.script.push({ reply: 'Read only answer.' })
      await ask(user, 'Hello?')
      await screen.findByText('Read only answer.')
      await answered()
      expect(lastQuestion(browser)).toMatch(/^\[Read only: /)
    }
    await closeBrowser()

    const { browser, user } = await openPanel(tab, 'user_bob')
    expect(screen.getByRole('button', { name: 'Mode: Edit' })).toBeVisible()
    browser.ai.script.push({ reply: 'Edit answer.' })
    await ask(user, 'Hello?')
    await screen.findByText('Edit answer.')
    expect(lastQuestion(browser)).not.toMatch(/Read only/)
  })

  it('[UC-NOTICO-AGENT-003-S04] a reopened session shows which question was asked in Read only', async () => {
    const { tab } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'First answer.' }, { reply: 'Second answer.' })
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
    await ask(user, 'First?')
    await screen.findByText('First answer.')
    await answered()
    await user.click(screen.getByRole('button', { name: 'Mode: Read only' }))
    await ask(user, 'Second?')
    await screen.findByText('Second answer.')
    await answered()

    await browser.openPanel()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await screen.findByRole('button', { name: /^First\?/ }))
    await conversation().findByText('Second answer.')
    const [first, second] = [conversation().getByText('First?'), conversation().getByText('Second?')]
    expect(within(first).getByText('Read only')).toBeVisible()
    expect(within(second).queryByText('Read only')).not.toBeInTheDocument()
  })
})
