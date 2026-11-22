import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const page = { id: '42', title: 'Attachment fixture', type: 'page', status: 'current' }
const pageUrl = base + '/pages/viewpage.action?pageId=42'
const resource = base + '/rest/api/content/42/child/attachment'
const name = 'review notes.txt'
const attachment = {
  id: 'att72',
  title: name,
  type: 'attachment',
  status: 'current',
  container: { id: '42', type: 'page' },
  version: { number: 1 },
  extensions: { fileSize: 24 },
  _links: { download: '/download/attachments/42/review+notes.txt?version=1' },
}
const list = { name: 'list_page_attachments', arguments: '{}' }
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')

it('[UC-CONFLUCO-CONFLUENCE-013-S01] shows bounded attachments and only valid download links', async () => {
  const { browser, user } = await openWorkspace({ url: pageUrl, title: page.title })
  const unsafe = {
    ...attachment,
    id: 'att73',
    title: 'unsafe.txt',
    _links: { download: 'https://elsewhere.test/download/attachments/42/unsafe.txt' },
  }
  browser.confluenceResponse = (address) => {
    if (!address.startsWith(resource)) return Response.json(page)
    const endpoint = new URL(address)
    expect(endpoint.searchParams.get('limit')).toBe('10')
    return Response.json({
      results: [attachment, unsafe],
      _links: { next: '/rest/api/content/42/child/attachment?start=2' },
    })
  }
  browser.ai.script.push({ toolCalls: [list] }, { reply: 'Two attachments.' })
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'List attachments')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByRole('link', { name: 'Download ' + name })).toHaveAttribute(
    'href',
    base + '/download/attachments/42/review%20notes.txt?version=1&download=true',
  )
  expect(screen.queryByRole('link', { name: 'Download unsafe.txt' })).not.toBeInTheDocument()
  await screen.findByText('Two attachments.')
  expect(JSON.stringify(browser.sentToModel())).toContain('nextPage')
  expect(writes(browser)).toHaveLength(0)
})
