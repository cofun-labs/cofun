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

/** Opens the latest reply's "…" and returns its popover. */
async function replyMenu(user: UserEvent) {
  await user.click(screen.getAllByRole('button', { name: 'Reply details' }).at(-1)!)
  return within(screen.getByRole('dialog', { name: 'Reply details' }))
}

/** Saves the latest reply from its "…", and returns the popover once the save has ended. */
async function saveReply(user: UserEvent) {
  const menu = await replyMenu(user)
  await user.click(menu.getByRole('button', { name: 'Save to Notion' }))
  await waitFor(() => expect(menu.queryByText('Saving to Notion…')).not.toBeInTheDocument())
  return menu
}

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

    const menu = await saveReply(user)

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
    // Where the user saved it, a link to the new page.
    expect(menu.getByRole('link', { name: 'Open the saved page' })).toHaveAttribute(
      'href',
      `https://app.notion.com/p/${hex(saved.id)}`,
    )
    expect(menu.queryByRole('button', { name: 'Save to Notion' })).not.toBeInTheDocument()

    // The link took the place of the button, and the focus with it.
    expect(menu.getByRole('link', { name: 'Open the saved page' })).toHaveFocus()
    // The link stays with the reply once its menu closes.
    await user.keyboard('{Escape}')
    const again = await replyMenu(user)
    expect(again.getByRole('link', { name: 'Open the saved page' })).toBeVisible()
  })

  it('[UC-NOTICO-SESSION-002-S02] a saved chat is saved from the chat list, every question and reply in order', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice owns them.' })
    await ask(user, 'What is on the roadmap?', 'Three milestones.')
    await ask(user, 'Who owns it?', 'Alice owns them.')

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const list = within(screen.getByRole('dialog', { name: 'Chats' }))
    await user.click(await list.findByRole('button', { name: 'More for this chat' }))
    await user.click(screen.getByRole('menuitem', { name: 'Save to Notion' }))

    const link = await list.findByRole('link', { name: 'Open the saved page' })
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
  })

  it("a reply's save stays with its chat: another chat's reply at the same place can be saved on its own", async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'First chat.' }, { reply: 'Second chat.' })
    await ask(user, 'One', 'First chat.')
    await saveReply(user)
    await user.click(screen.getAllByRole('button', { name: 'Reply details' }).at(-1)!)

    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Two', 'Second chat.')
    const menu = await replyMenu(user)
    expect(menu.queryByRole('link', { name: 'Open the saved page' })).not.toBeInTheDocument()
    await user.click(menu.getByRole('button', { name: 'Save to Notion' }))
    await menu.findByRole('link', { name: 'Open the saved page' })
    expect(
      workspace
        .content(PAGE)
        .slice(1)
        .map((p) => plain((p.properties as { title?: unknown }).title)),
    ).toEqual(['One', 'Two'])
  })

  it('saving from the chat list puts the focus back on the row\'s "…"', async () => {
    const { tab } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const more = await screen.findByRole('button', { name: 'More for this chat' })
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Save to Notion' }))
    expect(more).toHaveFocus()
    await screen.findByRole('link', { name: 'Open the saved page' })
  })

  it('a chat still saving when the list closes keeps its save: no second page, and the link when the list reopens', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?', 'Three milestones.')
    const release = tab.hold('saveTransactionsFanout')

    const list = () => within(screen.getByRole('dialog', { name: 'Chats' }))
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await list().findByRole('button', { name: 'More for this chat' }))
    await user.click(screen.getByRole('menuitem', { name: 'Save to Notion' }))
    await list().findByText('Saving to Notion…')
    await user.click(list().getByRole('button', { name: 'Close' }))

    // Reopened while the save is still out: it says so, and saving again starts nothing.
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    expect(await list().findByText('Saving to Notion…')).toBeVisible()
    await user.click(list().getByRole('button', { name: 'More for this chat' }))
    await user.click(screen.getByRole('menuitem', { name: 'Save to Notion' }))
    release()

    expect(await list().findByRole('link', { name: 'Open the saved page' })).toBeVisible()
    expect(endpoints(tab).filter((e) => e === 'saveTransactionsFanout')).toHaveLength(1)
    expect(workspace.transactions).toHaveLength(1)
  })

  it('[UC-NOTICO-SESSION-002-S03] off Notion, saving is unavailable and says to open a Notion page', async () => {
    const tab = new FakeNotionTab('https://example.com/article', 'An article')
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')

    const menu = await replyMenu(user)
    const save = menu.getByRole('button', { name: 'Save to Notion' })
    expect(save).toBeDisabled()
    expect(save).toHaveAccessibleDescription('Open a Notion page to save under it.')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await screen.findByRole('button', { name: 'More for this chat' }))
    const item = screen.getByRole('menuitem', { name: 'Save to Notion' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription('Open a Notion page to save under it.')
    await user.click(item)
    expect(screen.queryByText('Saving to Notion…')).not.toBeInTheDocument()
    expect(tab.sent).toEqual([])
  })

  it('[UC-NOTICO-SESSION-002-S04] a database open in the tab is not saved into, and the user is told why', async () => {
    const { tab, workspace } = workspaceTab(`https://app.notion.com/p/Tasks-${hex(TASKS)}`)
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')

    const menu = await saveReply(user)
    expect(menu.getByRole('alert')).toHaveTextContent(
      "Saving into a database isn't supported. Open a page to save under it.",
    )
    expect(workspace.transactions).toEqual([])
  })

  it('[UC-NOTICO-SESSION-002-S05] in Read only, a reply is saved as in Edit', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
    expect(screen.getByRole('button', { name: 'Mode: Read only' })).toBeVisible()
    browser.ai.script.push({ reply: 'It is a fixture.' })
    await ask(user, 'What does this page say?', 'It is a fixture.')

    const menu = await saveReply(user)
    expect(menu.getByRole('link', { name: 'Open the saved page' })).toBeVisible()
    expect(savedPage(workspace).blocks).toEqual([
      ['quote', 'What does this page say?'],
      ['text', 'It is a fixture.'],
    ])
  })

  it('[UC-NOTICO-SESSION-002-S06] when Notion turns the save away, nothing more is sent and the user is told to wait', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    tab.limit('saveTransactionsFanout', 1, 429, '30')

    const menu = await saveReply(user)
    expect(menu.getByRole('alert')).toHaveTextContent(
      'Notion is turning requests away right now (too many requests, or too busy), so nothing was saved. Wait 30 seconds, then try again.',
    )
    const sent = tab.sent.length
    // Trying again during the wait sends nothing.
    await user.click(menu.getByRole('button', { name: 'Save to Notion' }))
    await waitFor(() => expect(menu.queryByText('Saving to Notion…')).not.toBeInTheDocument())
    expect(menu.getByRole('alert')).toHaveTextContent('so nothing was saved')
    expect(tab.sent).toHaveLength(sent)
    expect(workspace.content(PAGE).map((b) => b.id)).toEqual([NOTE])
  })

  it('[UC-NOTICO-SESSION-002-S07] when Notion does not say whether the page was made, it is not retried and the user is told to check', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ reply: 'An answer.' })
    await ask(user, 'Hello', 'An answer.')
    workspace.failAfterApply = true

    const menu = await saveReply(user)
    expect(menu.getByRole('alert')).toHaveTextContent(
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

    await saveReply(user)
    const saved = savedPage(workspace)
    expect(saved.blocks[1]).toEqual(['text', 'Ask @Kim Lee to review it.'])
    expect(saved.runs[1]).toEqual([['Ask @Kim Lee to review it.']])
    // No member was looked up for it.
    expect(endpoints(tab)).not.toContain('getVisibleUsers')
  })
})
