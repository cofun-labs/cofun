import '@testing-library/jest-dom/vitest'
import { act, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace } from './confluence-fixture'

afterEach(closeWorkspace)

const selected = 'Synthetic unpublished selection 742'
const editor = {
  id: 1,
  url: base + '/pages/editpage.action?pageId=42',
  title: 'Editor fixture',
  meta: '<iframe id="wysiwygTextarea_ifr"></iframe>',
  editorSelection: selected,
}

async function openPanel(tab = editor) {
  const { browser, user } = await openWorkspace(tab)
  await user.click(await screen.findByText('Confluence', { selector: 'summary' }))
  const attach = () => user.click(screen.getByRole('button', { name: 'Attach editor selection' }))
  const send = async () => {
    browser.ai.script.push({ reply: 'Received the question.' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Explain this text')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Received the question.')
  }
  return { browser, user, attach, send }
}

it('[UC-CONFLUCO-CONFLUENCE-014-S01] sends only the reviewed editor selection with the question', async () => {
  const { browser, attach, send } = await openPanel()
  await attach()
  expect(await screen.findByRole('region', { name: 'Confluence editor selection' })).toHaveTextContent(selected)
  expect(browser.ai.calls).toEqual([])
  await send()
  const messages = JSON.stringify(browser.sentToModel())
  expect(messages).toContain(selected)
  expect(messages).toContain('Explain this text')
  expect(messages).not.toContain('Other editor text')
  expect(browser.workspaceRequests).toEqual([])
})

it('[UC-CONFLUCO-CONFLUENCE-014-S01] keeps the reviewed selection while the user looks at another tab', async () => {
  const { browser, attach, send } = await openPanel()
  await attach()
  await screen.findByRole('region', { name: 'Confluence editor selection' })
  await act(() => browser.selectTab({ ...editor, url: 'https://news.example.com/', title: 'News' }))
  await act(() => browser.selectTab(editor))
  expect(screen.getByRole('region', { name: 'Confluence editor selection' })).toHaveTextContent(selected)
  await send()
  expect(JSON.stringify(browser.sentToModel())).toContain(selected)
})

it('[UC-CONFLUCO-CONFLUENCE-014-S01] reports the actual original length when an editor selection is clipped', async () => {
  const { browser, attach, send } = await openPanel({ ...editor, editorSelection: 'x'.repeat(5_000) })
  await attach()
  const selection = await screen.findByRole('region', { name: 'Confluence editor selection' })
  expect(selection).toHaveTextContent('Selection limited to 4,000 characters.')
  await send()
  const messages = JSON.stringify(browser.sentToModel())
  expect(messages).toContain("the first 4,000 of the selection's 5,000 characters")
  expect(messages).not.toContain('x'.repeat(4_001))
})

it.each([
  [{ ...editor, editorSelection: '' }, /Select text in the Confluence editor/],
  [{ ...editor, url: base + '/pages/viewpage.action?pageId=42' }, /Open a supported Confluence editor/],
])('[UC-CONFLUCO-CONFLUENCE-014-S02] omits text outside a selected supported editor (%j)', async (tab, message) => {
  const { browser, attach, send } = await openPanel(tab)
  await attach()
  expect(await screen.findByText(message)).toBeVisible()
  await send()
  expect(JSON.stringify(browser.sentToModel())).not.toContain(selected)
  expect(browser.workspaceRequests).toEqual([])
})

it('[UC-CONFLUCO-CONFLUENCE-014-S02] offers no editor selection on a site Confluco may not use', async () => {
  const { browser } = await openWorkspace({
    ...editor,
    url: 'https://other.example.test/pages/editpage.action?pageId=42',
  })
  await screen.findByRole('textbox', { name: 'Message' })
  expect(screen.queryByText('Confluence', { selector: 'summary' })).toBeNull()
  expect(browser.workspaceRequests).toEqual([])
})

it.each(['removed', 'tab changed', 'editor reloaded'])(
  '[UC-CONFLUCO-CONFLUENCE-014-S03] omits a selection that was %s',
  async (scenario) => {
    const { browser, user, attach, send } = await openPanel()
    await attach()
    await screen.findByRole('region', { name: 'Confluence editor selection' })
    if (scenario === 'removed') await user.click(screen.getByRole('button', { name: 'Remove editor selection' }))
    else if (scenario === 'tab changed')
      browser.selectTab({ ...editor, id: 2, url: base + '/pages/editpage.action?pageId=84' })
    else browser.selectTab({ ...editor, documentId: 'reloaded-editor' })
    await send()
    if (scenario !== 'removed')
      expect(screen.getByText('The editor changed, so the selected text was omitted.')).toBeVisible()
    expect(JSON.stringify(browser.sentToModel())).not.toContain(selected)
    expect(browser.workspaceRequests).toEqual([])
  },
)

it('[UC-CONFLUCO-CONFLUENCE-014-S05] keeps a reviewed editor selection out of an attachment upload question', async () => {
  const { browser, user, attach, send } = await openPanel()
  await attach()
  const excerpt = await screen.findByRole('region', { name: 'Confluence editor selection' })
  await user.upload(screen.getByLabelText('Attachment file'), new File(['Fixture bytes'], 'fixture.txt'))
  browser.ai.script.push({ reply: 'Upload question received.' })
  await user.click(screen.getByRole('button', { name: 'Upload attachment' }))
  await screen.findByText('Upload question received.')
  expect(JSON.stringify(browser.sentToModel())).not.toContain(selected)
  expect(excerpt).toHaveTextContent(selected)
  await send()
  expect(JSON.stringify(browser.sentToModel())).toContain(selected)
})
