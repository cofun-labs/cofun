import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const page = { id: '42', title: 'Attachment fixture', type: 'page', status: 'current' }
const pageUrl = base + '/pages/viewpage.action?pageId=42'
const resource = base + '/rest/api/content/42/child/attachment'
const name = 'review notes.txt'
const content = 'Synthetic file bytes 742'
const attachment = {
  id: 'att72',
  title: name,
  type: 'attachment',
  status: 'current',
  container: { id: '42', type: 'page' },
  version: { number: 1 },
  extensions: { fileSize: content.length },
  _links: { download: '/download/attachments/42/review+notes.txt?version=1' },
}
const list = { name: 'list_page_attachments', arguments: '{}' }
const upload = { name: 'upload_page_attachment', arguments: '{}' }
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method === 'POST')

async function openPanel() {
  const { browser, user } = await openWorkspace({ url: pageUrl, title: page.title })
  await user.click(await screen.findByText('Confluence', { selector: 'summary' }))
  const selectFile = async (file = new File([content], name, { type: 'text/plain' })) =>
    user.upload(screen.getByLabelText('Attachment file'), file)
  return { browser, user, selectFile }
}

const answered = () => screen.findByRole('button', { name: 'Send' })

it('[UC-CONFLUCO-CONFLUENCE-013-S01] shows bounded attachments and only valid download links', async () => {
  const { browser, user } = await openPanel()
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
  expect(JSON.stringify(browser.sentToModel())).toContain('nextStart')
  expect(writes(browser)).toHaveLength(0)
})

it.each([false, true])(
  '[UC-CONFLUCO-CONFLUENCE-013-S02] confirms and verifies the exact upload (replacement %s)',
  async (replace) => {
    const { browser, user, selectFile } = await openPanel()
    let saved = replace ? attachment : undefined
    browser.confluenceResponse = async (address, init) => {
      if (!address.startsWith(resource)) return Response.json(page)
      if (init?.method === 'POST') {
        expect(address).toBe(replace ? resource + '/72/data' : resource + '?status=current')
        expect(new Headers(init.headers).get('X-Atlassian-Token')).toBe('nocheck')
        expect(init.body).toBeInstanceOf(FormData)
        if (!(init.body instanceof FormData)) throw new Error('Expected a multipart body')
        const file = init.body.get('file')
        expect(file).toBeInstanceOf(File)
        if (!(file instanceof File)) throw new Error('Expected a file part')
        expect(file.name).toBe(name)
        const uploaded = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(reader.error)
          reader.readAsText(file)
        })
        expect(uploaded).toBe(content)
        saved = { ...attachment, version: { number: replace ? 2 : 1 } }
        return Response.json(replace ? saved : { results: [saved] })
      }
      expect(new URL(address).searchParams.get('filename')).toBe(name)
      return Response.json({ results: saved ? [saved] : [] })
    }
    await selectFile()
    browser.ai.script.push({ toolCalls: [upload] }, { reply: 'The file is verified.' })
    await user.click(screen.getByRole('button', { name: replace ? 'Replace attachment' : 'Upload attachment' }))
    const allow = await screen.findByRole('button', { name: /^Allow$/ })
    expect(
      screen.getByText(replace ? /Replace version 1 of attachment.*review notes/ : /Upload attachment.*review notes/),
    ).toBeVisible()
    expect(writes(browser)).toHaveLength(0)
    await user.click(allow)
    expect(await screen.findByText('The file is verified.')).toBeVisible()
    expect(screen.getByLabelText('Attachment file')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    const conversation = JSON.stringify(browser.sentToModel())
    expect(conversation).toContain(name)
    expect(conversation).not.toContain(content)
  },
)

it.each(['missing file', 'collision', 'target changed', 'declined', 'too large'])(
  '[UC-CONFLUCO-CONFLUENCE-013-S03] leaves attachments intact when the action is %s',
  async (scenario) => {
    const { browser, user, selectFile } = await openPanel()
    let changed = false
    browser.confluenceResponse = (address) =>
      address.startsWith(resource)
        ? Response.json({ results: scenario === 'collision' ? [attachment] : [] })
        : Response.json(changed ? { ...page, title: 'Different title' } : page)
    browser.ai.script.push({ toolCalls: [upload] }, { reply: 'No attachment changed.' })
    if (scenario === 'missing file') {
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Upload a file')
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await answered()
      expect(screen.getAllByText(/Choose a local file/).length).toBeGreaterThan(0)
    } else if (scenario === 'too large') {
      await selectFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], name))
      expect(screen.getByRole('status')).toHaveTextContent('at most 10 MiB')
      expect(screen.queryByRole('button', { name: 'Upload attachment' })).not.toBeInTheDocument()
    } else {
      await selectFile()
      await user.click(screen.getByRole('button', { name: 'Upload attachment' }))
      if (scenario === 'declined') await user.click(await screen.findByRole('button', { name: /^Deny$/ }))
      if (scenario === 'target changed') {
        const allow = await screen.findByRole('button', { name: /^Allow$/ })
        changed = true
        await user.click(allow)
      }
      await answered()
      if (scenario === 'collision') expect(screen.getAllByText(/already exists/).length).toBeGreaterThan(0)
      if (scenario === 'target changed')
        expect(screen.getAllByText(/destination page changed/).length).toBeGreaterThan(0)
    }
    expect(writes(browser)).toHaveLength(0)
  },
)

it('[UC-CONFLUCO-CONFLUENCE-013-S03] refuses to replace an attachment that advanced after preview', async () => {
  const { browser, user, selectFile } = await openPanel()
  let version = 1
  browser.confluenceResponse = (address) =>
    address.startsWith(resource)
      ? Response.json({ results: [{ ...attachment, version: { number: version } }] })
      : Response.json(page)
  await selectFile()
  browser.ai.script.push({ toolCalls: [upload] })
  await user.click(screen.getByRole('button', { name: 'Replace attachment' }))
  const allow = await screen.findByRole('button', { name: /^Allow$/ })
  version = 2
  await user.click(allow)
  await answered()
  expect(screen.getAllByText(/attachment changed after the preview/).length).toBeGreaterThan(0)
  expect(writes(browser)).toHaveLength(0)
})

it.each([
  [403, /does not have permission/],
  [413, /rejected the upload/],
  [503, /may have been applied/],
  [200, /may have uploaded the file/],
])('[UC-CONFLUCO-CONFLUENCE-013-S04] stops after one upload when verification fails (%s)', async (status, reason) => {
  const { browser, user, selectFile } = await openPanel()
  browser.confluenceResponse = (address, init) => {
    if (!address.startsWith(resource)) return Response.json(page)
    if (init?.method !== 'POST') return Response.json({ results: [] })
    return status === 200 ? Response.json({ results: [attachment] }) : new Response(null, { status })
  }
  await selectFile()
  browser.ai.script.push({ toolCalls: [upload, upload] })
  await user.click(screen.getByRole('button', { name: 'Upload attachment' }))
  await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
  await answered()
  expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
  expect(writes(browser)).toHaveLength(1)
})

it('[UC-CONFLUCO-CONFLUENCE-013-S04] reports a rate limit verifying an upload and stops', async () => {
  const { browser, user, selectFile } = await openPanel()
  let written = false
  let verificationReads = 0
  browser.confluenceResponse = (address, init) => {
    if (init?.method === 'POST') {
      written = true
      return Response.json({ results: [attachment] })
    }
    if (written) {
      verificationReads++
      return new Response(null, { status: 429 })
    }
    return Response.json(address.startsWith(resource) ? { results: [] } : page)
  }
  await selectFile()
  browser.ai.script.push({ toolCalls: [upload, upload] })
  await user.click(screen.getByRole('button', { name: 'Upload attachment' }))
  await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
  await answered()
  expect(screen.getAllByText(/may have uploaded the file.*rate-limited/).length).toBeGreaterThan(0)
  expect(writes(browser)).toHaveLength(1)
  expect(verificationReads).toBe(1)
})
