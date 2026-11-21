// Undoing what a question changed (UC-NOTICO-NOTION-013), as a user does it in the side panel: from
// the reply's Undo, or by asking. Besides the screen, the tests look at the edges: what the model
// was told, and what Notion holds.
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
  const workspace = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      {
        id: PAGE,
        type: 'page',
        properties: { title: [['Fixture page']] },
        parent_id: SPACE,
        parent_table: 'space',
        content: [NOTE],
      },
      { id: NOTE, type: 'page', properties: { title: [['Old notes']] }, parent_id: PAGE, parent_table: 'block' },
    ],
    SPACE,
  )
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = workspace
  return { tab, workspace }
}

async function openPanel(tab: FakeNotionTab) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
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

/** The model renames "Old notes" to `title`. */
const rename = (title: string) => ({
  toolCalls: [{ name: 'update_pages', arguments: JSON.stringify({ pages: [{ page: hex(NOTE), title }] }) }],
})
const titleOf = (workspace: FakeWorkspace) =>
  (workspace.records.get(NOTE)!.properties as { title: string[][] }).title[0][0]

/** Undoes the question of the reply `n` (from 0) from its Undo, agreeing to what it shows. */
async function undoReply(user: UserEvent, n = 0) {
  await user.click(conversation().getAllByRole('button', { name: 'Undo changes' })[n])
  const card = screen.getByRole('group', { name: 'Undo what this reply changed in Notion?' })
  expect(card).toHaveTextContent('On “Old notes”: set back 1 value it changed')
  await user.click(within(card).getByRole('button', { name: 'Undo' }))
}

describe('UC-NOTICO-NOTION-013 undo what a question changed, in the side panel', () => {
  it('[UC-NOTICO-NOTION-013-S01] the reply of a question that changed a page undoes it, once the user agrees', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push(rename('Archive'), { reply: 'Renamed it.' }, { reply: 'Here it is.' })
    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText('Renamed it.')
    await answered()
    expect(titleOf(workspace)).toBe('Archive')

    // Asking first: Cancel changes nothing.
    await user.click(conversation().getByRole('button', { name: 'Undo changes' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(titleOf(workspace)).toBe('Archive')

    await undoReply(user)
    expect(await conversation().findByText('The changes were undone.')).toBeVisible()
    expect(titleOf(workspace)).toBe('Old notes')
    expect(conversation().queryByRole('button', { name: 'Undo changes' })).not.toBeInTheDocument()

    // A reply that changed nothing has no Undo.
    await ask(user, 'What is it called?')
    await screen.findByText('Here it is.')
    await answered()
    expect(conversation().queryByRole('button', { name: 'Undo changes' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-NOTION-013-S03] tells the user when the page changed since, and changes nothing', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push(rename('Archive'), { reply: 'Renamed it.' })
    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText('Renamed it.')
    await answered()
    workspace.edit(NOTE, { properties: { title: [['Archive 2026']] } })

    await undoReply(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Nothing was undone: “Old notes” changed since, and undoing would overwrite that\. Notion's page history/,
    )
    expect(titleOf(workspace)).toBe('Archive 2026')
    // Still offered: the user may change the page back and try again.
    expect(conversation().getByRole('button', { name: 'Undo changes' })).toBeVisible()
  })

  it('[UC-NOTICO-NOTION-013-S04] asked in words, the AI shows what it undoes and asks once; no keeps the change', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    const UNDO = { toolCalls: [{ name: 'undo_changes', arguments: '{}' }] }
    browser.ai.script.push(rename('Archive'), { reply: 'Renamed it.' }, UNDO, { reply: 'Kept it.' }, UNDO, {
      reply: 'Undone.',
    })
    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText('Renamed it.')
    await answered()

    await ask(user, 'Undo that')
    const asked = await screen.findByRole('group', { name: /^Allow this\?/ })
    expect(conversation().getByText(/On “Old notes”: set back 1 value it changed/)).toBeInTheDocument()
    await user.click(within(asked).getByRole('button', { name: 'Deny' }))
    await screen.findByText('Kept it.')
    await answered()
    expect(titleOf(workspace)).toBe('Archive')

    await ask(user, 'Undo it after all')
    await user.click(
      within(await screen.findByRole('group', { name: /^Allow this\?/ })).getByRole('button', { name: 'Allow' }),
    )
    await screen.findByText('Undone.')
    await answered()
    expect(titleOf(workspace)).toBe('Old notes')
    // The first reply's Undo says it is done.
    expect(conversation().getByText('The changes were undone.')).toBeVisible()
  })

  it('[UC-NOTICO-NOTION-013-S07] a chat opened again can still be undone, and stays undone', async () => {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push(rename('Archive'), { reply: 'Renamed it.' })
    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText('Renamed it.')
    await answered()

    const reopen = async () => {
      await browser.openPanel()
      await user.click(screen.getByRole('button', { name: 'Chats' }))
      const chats = within(await screen.findByRole('dialog', { name: 'Chats' }))
      await user.click((await chats.findAllByRole('button', { name: /Rename Old notes/ }))[0])
      await screen.findByText('Renamed it.')
    }
    await reopen()
    await undoReply(user)
    expect(await conversation().findByText('The changes were undone.')).toBeVisible()
    expect(titleOf(workspace)).toBe('Old notes')

    await reopen()
    expect(conversation().getByText('The changes were undone.')).toBeVisible()
    expect(conversation().queryByRole('button', { name: 'Undo changes' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-NOTION-013-S08] after an undo from the reply, the next question tells the AI, once', async () => {
    const { tab } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push(rename('Archive'), { reply: 'Renamed it.' }, { reply: 'Sure.' }, { reply: 'Fine.' })
    await ask(user, 'Rename Old notes to Archive')
    await screen.findByText('Renamed it.')
    await answered()
    await undoReply(user)
    await conversation().findByText('The changes were undone.')

    await ask(user, 'What next?')
    await screen.findByText('Sure.')
    await answered()
    const told = (m: { role: string; content?: string }) =>
      m.role === 'user' &&
      !!m.content?.includes('the user undid in Notion what an earlier question changed (on “Old notes”)')
    expect(browser.sentToModel().filter(told)).toHaveLength(1)

    await ask(user, 'And then?')
    await screen.findByText('Fine.')
    await answered()
    // Told with the question after the undo only.
    expect(browser.sentToModel().filter(told)).toHaveLength(1)
    expect(browser.sentToModel().findLast((m) => m.role === 'user')!.content).not.toContain('undid')
  })
})
