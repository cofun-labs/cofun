// Saving a reply or a whole chat to Notion (UC-NOTICO-SESSION-002), as a user does it from the side panel.
// Besides the screen, the tests look at what Notion was asked to do: the fake workspace applies the
// transaction, so the new page is read back from it.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const NOTE = '2c2c2c2c-0000-4000-8000-000000000021'
const TASKS = '3d3d3d3d-0000-4000-8000-000000000031'
const hex = (id: string) => id.replaceAll('-', '')

/** A tab on a workspace whose open page has one child page, "Old notes", and which has a database, "Tasks". */
function workspaceTab(url = PAGE_URL) {
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
      { id: TASKS, type: 'collection_view_page', parent_id: SPACE, parent_table: 'space' },
    ],
    SPACE,
  )
  const tab = new FakeNotionTab(url)
  tab.workspace = workspace
  return { tab, workspace }
}

async function openPanel(tab: FakeNotionTab) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
const answered = () => screen.findByRole('button', { name: 'Send' })

async function ask(user: UserEvent, question: string, reply: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText(reply, { exact: false })
  await answered()
}

/** The save buttons named `name` (the reply's, or the chat's in the header) that are still saving. */
const saving = (name: string) =>
  screen.queryAllByRole('button', { name }).filter((b) => b.getAttribute('aria-disabled') === 'true')

/** Presses a save button (the latest reply's, by default), and waits until the save has ended. */
async function save(user: UserEvent, name = 'Save reply to Notion') {
  await user.click(screen.getAllByRole('button', { name }).at(-1)!)
  await waitFor(() => expect(saving(name)).toEqual([]))
}

const toast = () => screen.getByRole('alert')

type Run = [string, [string, unknown?][]?]
const plain = (title: unknown) => ((title as Run[] | undefined) ?? []).map((r) => r[0]).join('')

/** The page added last at the end of the open page: its title, and its blocks as [type, text]. */
function savedPage(workspace: FakeWorkspace) {
  const page = workspace.content(PAGE).at(-1)!
  const props = (b: Record<string, unknown>) => b.properties as { title?: unknown } | undefined
  return {
    id: page.id,
    type: page.type,
    title: plain(props(page)?.title),
    blocks: workspace.content(page.id).map((b) => [b.type, plain(props(b)?.title)]),
    runs: workspace.content(page.id).map((b) => props(b)?.title as Run[] | undefined),
  }
}

/** The endpoints Notion was asked, in order. */
const endpoints = (tab: FakeNotionTab) => tab.sent.map((r) => new URL(r.url).pathname.split('/').at(-1))

/** The model reads the open page, renames "Old notes", then answers in Markdown. */
function readAndRename(browser: FakeBrowser) {
  browser.ai.script.push(
    { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
    {
      toolCalls: [
        { name: 'update_pages', arguments: JSON.stringify({ pages: [{ page: hex(NOTE), title: 'Archive' }] }) },
      ],
    },
    { reply: '## Done\n\n- Renamed **Old notes** to Archive.' },
  )
}

describe('UC-NOTICO-SESSION-002 save a chat or a reply to Notion', () => {
  it('[UC-NOTICO-SESSION-002-S01] a reply is saved under the open page, titled with the chat and its question, without tool details', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.titles.failWith = undefined
    browser.titles.script.push({ reply: 'Notes cleanup' })
    readAndRename(browser)
    await ask(user, 'Tidy up the notes', 'Renamed')
    // The chat has the model's title before the reply is saved.
    await screen.findByRole('heading', { name: 'Notes cleanup' })
    const made = workspace.transactions.length

    await save(user)

    // One transaction, made at once: nobody was asked to confirm.
    expect(workspace.transactions).toHaveLength(made + 1)
    const saved = savedPage(workspace)
    expect(saved.type).toBe('page')
    expect(saved.title).toBe('Notes cleanup — Tidy up the notes')
    expect(saved.blocks).toEqual([
      ['quote', 'Tidy up the notes'],
      ['sub_header', 'Done'],
      ['bulleted_list', 'Renamed Old notes to Archive.'],
      ['text', 'Read 1 page · Changed 1 page: ‣'],
    ])
    // Formatted as the reply was, and the line links the page that changed.
    expect(saved.runs[2]).toContainEqual(['Old notes', [['b']]])
    expect(saved.runs[3]!.at(-1)).toEqual([
      '‣',
      [
        ['h', 'gray'],
        ['p', NOTE],
      ],
    ])
    // Where the user saved it, a link to the new page took the button's place, and the focus.
    const link = screen.getByRole('link', { name: 'Open the saved reply' })
    expect(link).toHaveAttribute('href', `https://app.notion.com/p/${hex(saved.id)}`)
    expect(link).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Save reply to Notion' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-SESSION-002-S02] the whole chat is saved from the top of the panel, every question and reply in order', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    // A new chat has nothing to save.
    expect(screen.queryByRole('button', { name: 'Save chat to Notion' })).not.toBeInTheDocument()
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice owns them.' })
    await ask(user, 'What is on the roadmap?', 'Three milestones.')
    await ask(user, 'Who owns it?', 'Alice owns them.')

    await save(user, 'Save chat to Notion')

    const link = within(screen.getByRole('banner')).getByRole('link', { name: 'Open the saved chat' })
    const saved = savedPage(workspace)
    expect(link).toHaveAttribute('href', `https://app.notion.com/p/${hex(saved.id)}`)
    // The chat's title: its first question, since the model gave it none.
    expect(saved.title).toBe('What is on the roadmap?')
    expect(saved.blocks).toEqual([
      ['quote', 'What is on the roadmap?'],
      ['text', 'Three milestones.'],
      ['divider', ''],
      ['quote', 'Who owns it?'],
      ['text', 'Alice owns them.'],
    ])
    expect(workspace.transactions).toHaveLength(1)

    // Not while the chat list covers the chat.
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    expect(screen.queryByRole('link', { name: 'Open the saved chat' })).not.toBeInTheDocument()
  })

  it('once another question is answered, the chat can be saved again, with it', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice owns them.' })
    await ask(user, 'What is on the roadmap?', 'Three milestones.')
    await save(user, 'Save chat to Notion')
    expect(screen.getByRole('link', { name: 'Open the saved chat' })).toBeVisible()

    await ask(user, 'Who owns it?', 'Alice owns them.')
    await save(user, 'Save chat to Notion')
    expect(screen.getByRole('link', { name: 'Open the saved chat' })).toBeVisible()
    expect(savedPage(workspace).blocks.filter(([type]) => type === 'quote')).toEqual([
      ['quote', 'What is on the roadmap?'],
      ['quote', 'Who owns it?'],
    ])
    expect(workspace.transactions).toHaveLength(2)
  })

  it("a reply's save stays with its chat: another chat's reply at the same place can be saved on its own", async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'First chat.' }, { reply: 'Second chat.' })
    await ask(user, 'One', 'First chat.')
    await save(user)

    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Two', 'Second chat.')
    expect(screen.queryByRole('link', { name: 'Open the saved reply' })).not.toBeInTheDocument()
    await save(user)
    expect(screen.getByRole('link', { name: 'Open the saved reply' })).toBeVisible()
    expect(
      workspace
        .content(PAGE)
        .slice(1)
        .map((p) => plain((p.properties as { title?: unknown }).title)),
    ).toEqual(['One', 'Two'])
  })

  it('[UC-NOTICO-SESSION-002-S03] off Notion, saving is unavailable and says to open a Notion page', async () => {
    const tab = new FakeNotionTab('https://example.com/article', 'An article')
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')

    for (const name of ['Save reply to Notion', 'Save chat to Notion']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAccessibleDescription('Open a Notion page to save under it.')
      await user.click(button)
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(tab.sent).toEqual([])
  })

  it('[UC-NOTICO-SESSION-002-S04] a database open in the tab is not saved into, and the user is told why', async () => {
    const { tab, workspace } = workspaceTab(`https://app.notion.com/p/Tasks-${hex(TASKS)}`)
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')

    await save(user)
    expect(toast()).toHaveTextContent("Saving into a database isn't supported. Open a page to save under it.")
    expect(workspace.transactions).toEqual([])
    // The button stays as it was, to try again once a page is open; the message can be closed.
    expect(screen.getByRole('button', { name: 'Save reply to Notion' })).not.toHaveAttribute('aria-disabled')
    await user.click(within(toast()).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The focus was on the toast: it goes to the message box, not lost.
    expect(composer()).toHaveFocus()
  })

  it('[UC-NOTICO-SESSION-002-S05] in Read only, a reply is saved as in Edit', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
    expect(screen.getByRole('button', { name: 'Mode: Read only' })).toBeVisible()
    browser.ai.script.push({ reply: 'It is a fixture.' })
    await ask(user, 'What does this page say?', 'It is a fixture.')

    await save(user)
    expect(screen.getByRole('link', { name: 'Open the saved reply' })).toBeVisible()
    expect(savedPage(workspace).blocks).toEqual([
      ['quote', 'What does this page say?'],
      ['text', 'It is a fixture.'],
    ])
  })

  it('a save still running starts no other: pressing again while it saves makes one page', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    const release = tab.hold('saveTransactionsFanout')

    const button = screen.getByRole('button', { name: 'Save reply to Notion' })
    await user.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
    await user.click(button)
    release()

    await screen.findByRole('link', { name: 'Open the saved reply' })
    expect(endpoints(tab).filter((e) => e === 'saveTransactionsFanout')).toHaveLength(1)
    expect(workspace.transactions).toHaveLength(1)
  })

  it('[UC-NOTICO-SESSION-002-S06] when Notion turns the save away, nothing more is sent and the user is told to wait', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    tab.limit('saveTransactionsFanout', 1, 429, '30')

    await save(user)
    expect(toast()).toHaveTextContent(
      'Notion is turning requests away right now (too many requests, or too busy), so nothing was saved. Wait 30 seconds, then try again.',
    )
    const sent = tab.sent.length
    // Trying again during the wait sends nothing, and says so again.
    await user.click(within(toast()).getByRole('button', { name: 'Dismiss' }))
    await save(user)
    expect(toast()).toHaveTextContent('so nothing was saved')
    expect(tab.sent).toHaveLength(sent)
    expect(workspace.content(PAGE).map((b) => b.id)).toEqual([NOTE])
  })

  it('[UC-NOTICO-SESSION-002-S07] when Notion does not say whether the page was made, it is not retried and the user is told to check', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    workspace.failAfterApply = true

    await save(user)
    expect(toast()).toHaveTextContent(
      "Notion didn't say whether the page was created. Look at the end of the open page in Notion before saving again.",
    )
    expect(endpoints(tab).filter((e) => e === 'saveTransactionsFanout')).toHaveLength(1)
    // It was made: the one page the user is sent to check for.
    expect(savedPage(workspace).title).toBe('Hello')
  })

  it('[UC-NOTICO-SESSION-002-S08] a person a reply mentions is saved as their name, and nobody is mentioned', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'Ask @[Kim Lee] to review it.' })
    await ask(user, 'Who reviews?', 'to review it.')

    await save(user)
    const saved = savedPage(workspace)
    expect(saved.blocks[1]).toEqual(['text', 'Ask @Kim Lee to review it.'])
    expect(saved.runs[1]).toEqual([['Ask @Kim Lee to review it.']])
    // No member was looked up for it.
    expect(endpoints(tab)).not.toContain('getVisibleUsers')
  })
})
