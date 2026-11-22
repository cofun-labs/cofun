import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const pageUrl = (id: string) => `${base}/pages/viewpage.action?pageId=${id}`
const contentPath = '/kb/rest/api/content'
const storage = (value: string) => ({ value, representation: 'storage' })
const originalBody =
  '<p>Original</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="style">square</ac:parameter></ac:structured-macro><table><tbody><tr><td>Keep me</td></tr></tbody></table>'
const parent = {
  id: '42',
  type: 'page',
  status: 'current',
  title: 'Parent fixture',
  space: { key: 'TEST' },
  version: { number: 2 },
  ancestors: [{ id: '20' }],
  body: { storage: storage(originalBody) },
}
const child = { ...parent, id: '99', title: 'Child fixture', ancestors: [{ id: '20' }, { id: '42' }] }
const command = 'Add a child page for the meeting notes'
const rename = 'Give this page a clearer title'
const createCall = { name: 'create_page', arguments: JSON.stringify({ title: child.title }) }
const renameCall = { name: 'rename_page', arguments: JSON.stringify({ title: 'Renamed fixture' }) }

async function openPanel() {
  const { browser, user } = await openWorkspace({ url: pageUrl(parent.id), title: parent.title })
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const answered = () => screen.findByRole('button', { name: 'Send' })
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')

function pendingResponse<T = Response>() {
  let release!: (response: T) => void
  const promise = new Promise<T>((resolve) => (release = resolve))
  return { promise, release }
}

const modelResults = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => content)
    .join('\n')

describe('move a published page to the trash', () => {
  const trash = { name: 'trash_page', arguments: '{}' }
  const trashed = { ...parent, status: 'trashed', ancestors: [] }
  const empty = { results: [] }
  const unrestricted = { restrictions: { user: empty, group: empty } }
  const question = 'This page is obsolete, please remove it'
  const usePage = (browser: WorkspaceBrowser) => {
    let page: typeof parent & { metadata?: { trashdate: string } } = parent
    browser.confluenceResponse = (url, init) => {
      const endpoint = new URL(url)
      if (endpoint.pathname.endsWith('/child/page')) return Response.json(empty)
      if (endpoint.pathname.endsWith('/restriction/byOperation'))
        return Response.json({ read: unrestricted, update: unrestricted })
      expect(endpoint.pathname).toBe(contentPath + '/42')
      if (init?.method === 'DELETE') {
        expect(screen.getByText(/Move "Parent fixture".*to the recoverable trash/)).toBeVisible()
        expect(screen.queryByRole('img', { name: 'Waiting for your OK' })).not.toBeInTheDocument()
        expect(endpoint.search).toBe('?status=current')
        page = { ...trashed, metadata: { trashdate: '2026-01-01T00:00:00.000Z' } }
        return new Response(null, { status: 204 })
      }
      expect(endpoint.searchParams.get('status')).toBe('any')
      return Response.json(page)
    }
  }

  it('[UC-CONFLUCO-CONFLUENCE-012-S01] confirms the page and verifies recoverable trash after dispatch', async () => {
    const { browser, user } = await openPanel()
    usePage(browser)
    browser.ai.script.push({ toolCalls: [trash] }, { reply: 'Trashed and verified.' })
    await ask(user, question)
    expect(await screen.findByText(/may move child pages that your account cannot see/)).toBeVisible()
    expect(writes(browser)).toEqual([])
    await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
    expect(await screen.findByText('Trashed and verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(modelResults(browser)).toContain('"status":"trashed","version":2,"changed":true')
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
  })

  it('[UC-CONFLUCO-CONFLUENCE-012-S03] leaves the page published when the user denies the card', async () => {
    const { browser, user } = await openPanel()
    usePage(browser)
    browser.ai.script.push({ toolCalls: [trash] }, { reply: 'The page is still published.' })
    await ask(user, question)
    await user.click(await screen.findByRole('button', { name: /^Deny$/ }))
    expect(await screen.findByText('The page is still published.')).toBeVisible()
    expect(writes(browser)).toEqual([])
  })

  it.each([
    ['already trashed', trashed, false, false, /"changed":false/],
    ['top-level', { ...parent, ancestors: [] }, false, false, /top-level pages/],
    ['with child pages', parent, true, false, /child pages/],
    ['restricted', parent, false, false, /could lose an access restriction/],
    ['denied', parent, false, true, /permission/i],
    ['unexpected', { ...parent, id: '99' }, false, false, /expected published or trashed page/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-012-S03] does not change an ineligible page (%s)',
    async (kind, page, hasChildren, denied, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url, init) => {
        if (init?.method === 'DELETE' && denied) return new Response(null, { status: 403 })
        if (new URL(url).pathname.endsWith('/child/page'))
          return Response.json({ results: hasChildren ? [{ id: '99' }] : [] })
        if (new URL(url).pathname.endsWith('/restriction/byOperation'))
          return Response.json({
            read: { restrictions: { user: { results: kind === 'restricted' ? [{}] : [] }, group: empty } },
            update: unrestricted,
          })
        return Response.json(page)
      }
      browser.ai.script.push({ toolCalls: [trash] }, { reply: 'The page was left as it is.' })
      await ask(user, question)
      if (denied) await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
      await answered()
      // Denied and unexpected responses stop the question; the others go back to the model.
      if (denied || kind === 'unexpected') expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      else {
        expect(screen.getByText('The page was left as it is.')).toBeVisible()
        expect(modelResults(browser)).toMatch(reason)
      }
      expect(writes(browser)).toHaveLength(denied ? 1 : 0)
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-012-S04] reports a rate-limited state verification', async () => {
    const { browser, user } = await openPanel()
    let written = false
    let verificationReads = 0
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'DELETE') {
        written = true
        return new Response(null, { status: 204 })
      }
      if (written) {
        verificationReads++
        return new Response(null, { status: 429 })
      }
      if (new URL(url).pathname.endsWith('/child/page')) return Response.json(empty)
      if (new URL(url).pathname.endsWith('/restriction/byOperation'))
        return Response.json({ read: unrestricted, update: unrestricted })
      return Response.json(parent)
    }
    browser.ai.script.push({ toolCalls: [trash, trash] })
    await ask(user, question)
    await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
    await answered()
    expect(screen.getAllByText(/page state may have changed.*rate-limited/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    expect(verificationReads).toBe(1)
  })

  it('[UC-CONFLUCO-CONFLUENCE-012-S04] verifies uncertainty once', async () => {
    const { browser, user } = await openPanel()
    let readsAfterWrite = 0
    let attempted = false
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'DELETE') {
        attempted = true
        return new Response(null, { status: 503 })
      }
      if (attempted) readsAfterWrite++
      if (new URL(url).pathname.endsWith('/child/page')) return Response.json(empty)
      if (new URL(url).pathname.endsWith('/restriction/byOperation'))
        return Response.json({ read: unrestricted, update: unrestricted })
      return Response.json(parent)
    }
    browser.ai.script.push({ toolCalls: [trash, trash] })
    await ask(user, question)
    await user.click(await screen.findByRole('button', { name: /^Allow$/ }))
    await answered()
    expect(writes(browser)).toHaveLength(1)
    expect(readsAfterWrite).toBe(1)
    expect(screen.getAllByText(/page state may have changed/).length).toBeGreaterThan(0)
  })
})

describe('create a published page', () => {
  it('[UC-CONFLUCO-CONFLUENCE-007-S01] shows the chosen parent and verifies the published child', async () => {
    const { browser, user } = await openPanel()
    const expectedBody = storage('<p>Literal &lt;tag&gt; &amp; text</p>')
    const created = { ...child, body: { storage: expectedBody }, version: { number: 1 } }
    const response = pendingResponse()
    const preview = `Create "Child fixture" under "Parent fixture" (${pageUrl('42')}) in space TEST on ${base}.`
    browser.confluenceResponse = (url, init) => {
      const endpoint = new URL(url)
      if (init?.method === 'POST') {
        expect(screen.getByText(preview)).toBeVisible()
        return response.promise
      }
      if (endpoint.pathname === contentPath) return Response.json({ results: [] })
      if (endpoint.pathname === `${contentPath}/99`) return Response.json(created)
      return Response.json(parent)
    }
    const call = {
      name: 'create_page',
      arguments: JSON.stringify({ title: child.title, text: 'Literal <tag> & text', parent: pageUrl('42') }),
    }
    browser.ai.script.push({ toolCalls: [call] }, { reply: 'Child created and verified.' })
    await ask(user, command)
    expect(await screen.findByText(preview)).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Waiting for your OK' })).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
    expect(writes(browser)[0]).toMatchObject({
      url: base + '/rest/api/content',
      init: {
        method: 'POST',
        body: JSON.stringify({
          type: 'page',
          title: child.title,
          space: parent.space,
          ancestors: [{ id: parent.id }],
          body: { storage: expectedBody },
        }),
      },
    })
    response.release(Response.json(created))
    expect(await screen.findByText('Child created and verified.')).toBeVisible()
    expect(browser.workspaceRequests.at(-1)?.url).toContain(`${contentPath}/99?expand=`)
    expect(modelResults(browser)).toContain(pageUrl('99'))
    expect(modelResults(browser)).toContain('"version":1,"changed":true,"bodyVerified":true')
  })

  it.each([undefined, pageUrl('42'), base + '/spaces/TEST/pages/42/Parent+fixture'])(
    '[UC-CONFLUCO-CONFLUENCE-007-S02] reports an existing title without creating another page (parent %s)',
    async (parentLink) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url) => {
        const endpoint = new URL(url)
        if (endpoint.pathname !== contentPath) return Response.json(parent)
        expect(endpoint.searchParams.get('title')).toBe(child.title)
        expect(endpoint.searchParams.get('spaceKey')).toBe(parent.space.key)
        return Response.json({ results: [child] })
      }
      const call = { name: 'create_page', arguments: JSON.stringify({ title: child.title, parent: parentLink }) }
      browser.ai.script.push({ toolCalls: [call] }, { reply: 'The page already exists.' })
      await ask(user, command)
      expect(await screen.findByText('The page already exists.')).toBeVisible()
      expect(modelResults(browser)).toContain('"changed":false,"alreadyExists":true')
      expect(modelResults(browser)).toContain(pageUrl('99'))
      expect(writes(browser)).toEqual([])
    },
  )

  it('[@no-uc:data] keeps the planned change visible when the user opens Sessions before the write', async () => {
    const { browser, user } = await openPanel()
    const parentResponse = pendingResponse()
    const writeResponse = pendingResponse()
    const created = { ...child, body: { storage: storage('<p></p>') } }
    browser.confluenceResponse = (url, init) => {
      const path = new URL(url).pathname
      if (init?.method === 'POST') {
        expect(screen.getByRole('status')).toBeVisible()
        expect(screen.getByRole('status')).toHaveTextContent('Create "Child fixture" under "Parent fixture"')
        return writeResponse.promise
      }
      if (path === contentPath) return Response.json({ results: [] })
      if (path === `${contentPath}/99`) return Response.json(created)
      return browser.workspaceRequests.length === 1 ? parentResponse.promise : Response.json(parent)
    }
    browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Created from the active chat.' })
    await ask(user, command)
    await screen.findByRole('img', { name: 'Running' })
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    expect(writes(browser)).toEqual([])
    parentResponse.release(Response.json(parent))
    expect(await screen.findByRole('status')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    writeResponse.release(Response.json(created))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(await screen.findByText('Created from the active chat.')).toBeVisible()
  })

  it.each([
    [403, /does not have permission/],
    [503, /change may have been applied/],
  ])('[UC-CONFLUCO-CONFLUENCE-007-S03] reports a denied or uncertain creation (%s)', async (status, message) => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'POST') return new Response(null, { status })
      return Response.json(new URL(url).pathname === contentPath ? { results: [] } : parent)
    }
    browser.ai.script.push({ toolCalls: [createCall, createCall] })
    await ask(user, command)
    await answered()
    expect(screen.getAllByText(message).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    expect(browser.ai.calls).toHaveLength(1)
    if (status === 503) {
      browser.confluenceResponse = (url) =>
        Response.json(new URL(url).pathname === contentPath ? { results: [child] } : parent)
      browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Found the page from the earlier request.' })
      await ask(user, command)
      expect(await screen.findByText('Found the page from the earlier request.')).toBeVisible()
      expect(writes(browser)).toHaveLength(1)
    }
  })

  it('[@no-uc:access] refuses a parent link on another site without sending a request', async () => {
    const { browser, user } = await openPanel()
    const call = {
      name: 'create_page',
      arguments: JSON.stringify({
        title: child.title,
        parent: 'https://other.example.test/kb/pages/viewpage.action?pageId=42',
      }),
    }
    browser.ai.script.push({ toolCalls: [call] }, { reply: 'No page created.' })
    await ask(user, command)
    expect(await screen.findByText('No page created.')).toBeVisible()
    expect(modelResults(browser)).toContain('find the page with search_pages and pass its reference')
    expect(browser.workspaceRequests).toEqual([])
  })
})

describe('rename a published page', () => {
  it('[UC-CONFLUCO-CONFLUENCE-008-S01] renames the same page with untouched storage and parent', async () => {
    const { browser, user } = await openPanel()
    const updated = { ...parent, title: 'Renamed fixture', version: { number: 3 } }
    const response = pendingResponse()
    let applied = false
    browser.confluenceResponse = (url, init) => {
      expect(new URL(url).pathname).toBe(`${contentPath}/42`)
      if (init?.method === 'PUT') {
        applied = true
        return response.promise
      }
      return Response.json(applied ? updated : parent)
    }
    browser.ai.script.push({ toolCalls: [renameCall] }, { reply: 'Renamed the existing page.' })
    await ask(user, '给当前页换一个更清楚的标题')
    expect(
      await screen.findByText(
        `Rename "Parent fixture" (${pageUrl('42')}) in space TEST on ${base} to "Renamed fixture".`,
      ),
    ).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Waiting for your OK' })).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
    expect(writes(browser)[0]).toMatchObject({
      url: base + '/rest/api/content/42',
      init: {
        method: 'PUT',
        body: JSON.stringify({ type: 'page', title: updated.title, version: { number: 3 }, body: parent.body }),
      },
    })
    response.release(Response.json(updated))
    expect(await screen.findByText('Renamed the existing page.')).toBeVisible()
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    expect(modelResults(browser)).toContain(pageUrl('42'))
    expect(modelResults(browser)).toContain(
      '"previousTitle":"Parent fixture","version":3,"changed":true,"contentPreserved":true',
    )
    expect(modelResults(browser)).not.toContain(originalBody)
    expect(writes(browser)).toHaveLength(1)
  })

  it.each([false, true])(
    '[UC-CONFLUCO-CONFLUENCE-008-S02] preserves a newer version (server detects conflict %s)',
    async (conflict) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 409 })
        return Response.json(
          conflict || browser.workspaceRequests.length === 1 ? parent : { ...parent, version: { number: 3 } },
        )
      }
      browser.ai.script.push({ toolCalls: [renameCall, renameCall] })
      await ask(user, rename)
      await answered()
      expect(
        screen.getAllByText(conflict ? /has a newer version/ : /changed after the preview/).length,
      ).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(conflict ? 1 : 0)
      expect(screen.queryByText(/Some changes in this question may already have been made/)).not.toBeInTheDocument()
    },
  )

  it.each([
    [false, /does not have permission/],
    [true, /resulting page could not be verified/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-008-S03] reports a denied or unverifiable rename (applied %s)',
    async (applied, message) => {
      const { browser, user } = await openPanel()
      let written = false
      const updated = { ...parent, title: 'Renamed fixture', version: { number: 3 } }
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') {
          written = true
          return applied ? Response.json(updated) : new Response(null, { status: 403 })
        }
        return Response.json(written ? { ...updated, body: { storage: storage('<p>Unexpected body</p>') } } : parent)
      }
      browser.ai.script.push({ toolCalls: [renameCall] })
      await ask(user, rename)
      await answered()
      expect(screen.getAllByText(message).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(1)
    },
  )

  it('[@no-uc:data] reports a rejected title without an uncertain-write warning', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (_url, init) =>
      init?.method === 'PUT' ? new Response(null, { status: 400 }) : Response.json(parent)
    browser.ai.script.push({ toolCalls: [renameCall] })
    await ask(user, rename)
    await answered()
    expect(screen.getAllByText(/Check that the title is valid and unique in the chosen space/).length).toBeGreaterThan(
      0,
    )
    expect(screen.queryByText(/Some changes in this question may already have been made/)).not.toBeInTheDocument()
    expect(writes(browser)).toHaveLength(1)
  })
})

describe('edit published page text', () => {
  const edit = 'Update the status line: QA says it is ready today'
  const editWith = (before: string, after: string) => ({
    name: 'edit_page',
    arguments: JSON.stringify({ before, after }),
  })
  const editCall = editWith('Status A & B', `QA's "ready" <today>`)
  const preserved =
    '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Status A &amp; B</ac:parameter>' +
    '<ac:rich-text-body><p>Keep me</p></ac:rich-text-body></ac:structured-macro>' +
    '<table><tbody><tr><td><ac:link><ri:attachment ri:filename="guide.pdf" /></ac:link></td>' +
    '<td><ac:link><ri:user ri:userkey="synthetic-user" /></ac:link></td></tr></tbody></table>' +
    '<custom:tag attribute="a > b"><![CDATA[Status A & B <raw>]]></custom:tag>'
  const tasks =
    '<ac:task-list><ac:task><ac:task-id>19</ac:task-id><ac:task-uuid>fixture-id</ac:task-uuid>' +
    '<ac:task-status>incomplete</ac:task-status><ac:task-body>Check the release</ac:task-body></ac:task></ac:task-list>'
  const body = '<p>Prefix: Status A &#38; B. Keep &#160; suffix.</p>' + preserved
  const expected = "<p>Prefix: QA's &quot;ready&quot; &lt;today&gt;. Keep &#160; suffix.</p>" + preserved
  const original = { ...parent, body: { storage: storage(body) } }
  const updated = { ...original, body: { storage: storage(expected) }, version: { number: 3 } }

  it('[UC-CONFLUCO-CONFLUENCE-009-S01] shows the edit before dispatch and preserves surrounding storage', async () => {
    const { browser, user } = await openPanel()
    let written = false
    browser.confluenceResponse = (url, init) => {
      expect(new URL(url).pathname).toBe(`${contentPath}/42`)
      if (init?.method === 'PUT') {
        expect(screen.getByText(/Edit "Parent fixture".*version 2/)).toHaveTextContent('Before: "Status A & B"')
        expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
        written = true
        expect(init.body).toEqual(
          JSON.stringify({ type: 'page', title: original.title, version: { number: 3 }, body: updated.body }),
        )
      }
      return Response.json(written ? updated : original)
    }
    browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'The edit was verified.' })
    await ask(user, edit)
    expect(await screen.findByText('The edit was verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    expect(modelResults(browser)).toContain('"version":3,"changed":true,"bodyVerified":true')
    expect(modelResults(browser)).not.toContain(preserved)
  })

  it.each([
    ['twice', editCall, body + '<p>Status A &amp; B</p>', /appears more than once/],
    ['split by formatting', editCall, '<p>Status <em>A &amp; B</em></p>', /not in one editable text segment/],
    ['in task metadata', editWith('incomplete', 'complete'), tasks, /not in one editable text segment/],
    ['reserved markup', editWith('OLD', ']]'), '<p>OLD> suffix</p>', /reserved markup sequence/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-009-S02] leaves the page unchanged and tells the model why (%s)',
    async (_case, call, value, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = () => Response.json({ ...original, body: { storage: storage(value) } })
      browser.ai.script.push({ toolCalls: [call] }, { reply: 'I need to quote one current passage.' })
      await ask(user, edit)
      expect(await screen.findByText('I need to quote one current passage.')).toBeVisible()
      expect(modelResults(browser)).toMatch(reason)
      expect(writes(browser)).toEqual([])
    },
  )

  it.each([false, true])(
    '[UC-CONFLUCO-CONFLUENCE-009-S03] protects newer content (server conflict %s)',
    async (conflict) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 409 })
        return Response.json(
          browser.workspaceRequests.length > 1 && !conflict ? { ...original, version: { number: 3 } } : original,
        )
      }
      browser.ai.script.push({ toolCalls: [editCall, editCall] })
      await ask(user, edit)
      await answered()
      expect(
        screen.getAllByText(conflict ? /has a newer version/ : /changed after the preview/).length,
      ).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(conflict ? 1 : 0)
    },
  )

  it.each([false, true])(
    '[UC-CONFLUCO-CONFLUENCE-009-S04] verifies an uncertain write once (applied %s)',
    async (applied) => {
      const { browser, user } = await openPanel()
      let dispatched = false
      browser.confluenceResponse = (_url, init) => {
        if (init?.method === 'PUT') {
          dispatched = true
          return new Response(null, { status: 503 })
        }
        return Response.json(dispatched && applied ? updated : original)
      }
      browser.ai.script.push({ toolCalls: [editCall] }, { reply: 'Verified after read-back.' })
      await ask(user, edit)
      await answered()
      expect(writes(browser)).toHaveLength(1)
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
      if (applied) expect(modelResults(browser)).toContain('"recovered":true')
      else expect(screen.getAllByText(/resulting page could not be verified/).length).toBeGreaterThan(0)
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-009-S04] retains the rate limit and uncertain change warning after an edit', async () => {
    const { browser, user } = await openPanel()
    let written = false
    let verificationReads = 0
    browser.confluenceResponse = (_url, init) => {
      if (init?.method === 'PUT') {
        written = true
        return Response.json(updated)
      }
      if (written) {
        verificationReads++
        return new Response(null, { status: 429 })
      }
      return Response.json(original)
    }
    browser.ai.script.push({ toolCalls: [editCall, editCall] })
    await ask(user, edit)
    await answered()
    expect(screen.getAllByText(/may have applied the change.*rate-limited/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    expect(verificationReads).toBe(1)
  })

  it('[UC-CONFLUCO-CONFLUENCE-009-S09] stops after an explicit sign-in refusal without issuing a verification read', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (_url, init) =>
      init?.method === 'PUT' ? new Response(null, { status: 401 }) : Response.json(original)
    browser.ai.script.push({ toolCalls: [editCall] })
    await ask(user, edit)
    await answered()
    expect(screen.getAllByText(/Sign in to Confluence in the page tab/).length).toBeGreaterThan(0)
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('PUT')
    expect(writes(browser)).toHaveLength(1)
  })
})

it('[UC-CONFLUCO-CONFLUENCE-007-S06] blocks a model-requested write in Read only before the preview', async () => {
  const { browser, user } = await openPanel()
  await user.click(screen.getByRole('button', { name: 'Mode: Edit' }))
  await screen.findByRole('button', { name: 'Mode: Read only' })
  browser.ai.script.push({ toolCalls: [createCall] }, { reply: 'Read only blocks this change.' })
  await ask(user, command)
  expect(await screen.findByText('Read only blocks this change.')).toBeVisible()
  expect(browser.workspaceRequests).toEqual([])
  expect(modelResults(browser)).toContain('this question is in Read only')
})
