import { followConfluencePage } from './confluence-fixture'
import '@testing-library/jest-dom/vitest'
import { screen, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const pageUrl = base + '/pages/viewpage.action?pageId=42'
const current = { id: '42', type: 'page', status: 'current', title: 'Fixture page' }
const revision = { number: 12, when: '2026-11-02T12:01:00Z', by: { displayName: 'Fixture author' }, message: 'Updated' }
const label = { name: 'sample-label', prefix: 'global' }
const labelPath = '/kb/rest/api/content/42/label'

const tool = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })

async function panel() {
  const { browser, user } = await openWorkspace({ url: pageUrl, title: current.title })
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

function toolText(browser: WorkspaceBrowser) {
  return browser
    .sentToModel()
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n')
}

const answered = () => screen.findByRole('button', { name: 'Send' })
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')

describe('published page history and access', () => {
  it('[UC-CONFLUCO-CONFLUENCE-005-S01] lists published versions and reads the next set', async () => {
    const { browser, user } = await panel()
    browser.confluenceResponse = (url) => {
      const endpoint = new URL(url)
      if (!endpoint.pathname.includes('/rest/experimental/')) return Response.json({ ...current, version: revision })
      if (endpoint.searchParams.get('start') === '0') {
        return Response.json({
          results: [revision],
          _links: { next: '/rest/experimental/content/42/version?start=10&limit=10' },
        })
      }
      return Response.json({ results: [{ number: 2, message: 'Older marker' }] })
    }
    browser.ai.script.push({ toolCalls: [tool('list_page_versions')] })
    followConfluencePage(browser, (nextPage) => {
      browser.ai.script.push(
        { toolCalls: [tool('list_page_versions', { nextPage })] },
        { reply: 'Found older history.' },
      )
    })
    await ask(user, 'Show the version history')
    expect(await screen.findByText('Found older history.')).toBeVisible()
    expect(toolText(browser)).toContain('"nextPage":')
    expect(toolText(browser)).toContain('Fixture author')
    expect(toolText(browser)).toContain('Older marker')
    expect(toolText(browser)).toContain('/pages/viewpreviousversions.action?pageId=42')
    expect(browser.workspaceRequests.at(-1)?.url).toBe(base + '/rest/experimental/content/42/version?start=10&limit=10')
  })

  it.each(['historical', 'current'])(
    '[UC-CONFLUCO-CONFLUENCE-005-S02] reads a numbered version with status %s',
    async (status) => {
      const { browser, user } = await panel()
      browser.confluenceResponse = () =>
        Response.json({
          ...current,
          status,
          version: { number: 2 },
          body: { view: { value: '<p>Old page body only.</p><script>Hidden</script>' } },
        })
      browser.ai.script.push({ toolCalls: [tool('read_page_version', { version: 2 })] }, { reply: 'Read version 2.' })
      await ask(user, 'Read version 2')
      expect(await screen.findByText('Read version 2.')).toBeVisible()
      expect(toolText(browser)).toContain('Old page body only.')
      expect(toolText(browser)).not.toContain('Hidden')
      expect(toolText(browser)).toContain('/pages/viewpreviousversions.action?pageId=42')
      const endpoint = new URL(browser.workspaceRequests[0]!.url)
      expect(endpoint.pathname).toBe('/kb/rest/api/content/42')
      expect(endpoint.searchParams.get('version')).toBe('2')
      expect(endpoint.searchParams.get('status')).toBe('historical')
    },
  )

  it.each([
    [() => new Response(null, { status: 404 }), 'is missing or is not visible'],
    [
      () =>
        Response.json({
          ...current,
          status: 'historical',
          version: { number: 1 },
          body: { view: { value: 'Wrong version' } },
        }),
      'did not return the requested page version',
    ],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-005-S03] refuses a missing or different historical version',
    async (response, message) => {
      const { browser, user } = await panel()
      browser.confluenceResponse = response
      browser.ai.script.push({ toolCalls: [tool('read_page_version', { version: 2 })] })
      await ask(user, 'Read the old version 2')
      await answered()
      expect(screen.getAllByText(new RegExp(message)).length).toBeGreaterThan(0)
      expect(browser.ai.calls).toHaveLength(1)
    },
  )

  it.each([true, false])(
    '[UC-CONFLUCO-CONFLUENCE-005-S04] reports operations and whether restrictions were available (%s)',
    async (available) => {
      const { browser, user } = await panel()
      browser.confluenceResponse = (url) => {
        if (!url.endsWith('/restriction/byOperation'))
          return Response.json({ ...current, operations: [{ operation: 'read', targetType: 'page' }] })
        const operation = (users: unknown[]) => ({ restrictions: { user: { results: users }, group: { results: [] } } })
        return available
          ? Response.json({ read: operation([]), update: operation([{ displayName: 'Unneeded name' }]) })
          : new Response(null, { status: 403 })
      }
      browser.ai.script.push({ toolCalls: [tool('get_page_access')] }, { reply: 'Access details received.' })
      await ask(user, 'What can I do on this page?')
      expect(await screen.findByText('Access details received.')).toBeVisible()
      const result = toolText(browser)
      expect(result).toContain('"operation":"read"')
      expect(result).toContain(available ? '"restrictions":{"read":false,"update":true}' : '"restrictions":null')
      expect(result).not.toContain('Unneeded name')
    },
  )
})

describe('published page labels', () => {
  it('[UC-CONFLUCO-CONFLUENCE-006-S01] lists labels with a bounded continuation', async () => {
    const { browser, user } = await panel()
    browser.confluenceResponse = (url) => {
      const endpoint = new URL(url)
      if (endpoint.pathname !== labelPath) return Response.json(current)
      return endpoint.searchParams.get('start') === '0'
        ? Response.json({ results: [label], _links: { next: '/rest/api/content/42/label?limit=10&start=10' } })
        : Response.json({ results: [{ name: 'second-label', prefix: 'global' }] })
    }
    browser.ai.script.push({ toolCalls: [tool('list_page_labels')] })
    followConfluencePage(browser, (nextPage) => {
      browser.ai.script.push({ toolCalls: [tool('list_page_labels', { nextPage })] }, { reply: 'More labels.' })
    })
    await ask(user, 'List the labels')
    expect(await screen.findByText('More labels.')).toBeVisible()
    expect(toolText(browser)).toContain('"nextPage":')
    expect(toolText(browser)).toContain('second-label')
  })

  it.each(['add', 'remove'])(
    '[UC-CONFLUCO-CONFLUENCE-006-S02] applies and reads back the label the model chose to %s',
    async (action) => {
      const { browser, user } = await panel()
      const adding = action === 'add'
      let present = !adding
      browser.confluenceResponse = (url, init) => {
        if (new URL(url).pathname !== labelPath) return Response.json(current)
        if (init?.method === 'POST' || init?.method === 'DELETE') {
          present = init.method === 'POST'
          return present ? Response.json({ results: [label] }) : new Response(null, { status: 204 })
        }
        return Response.json({ results: present ? [label] : [] })
      }
      browser.ai.script.push(
        { toolCalls: [tool('change_page_label', { label: 'Sample-Label', action })] },
        { reply: 'Label state verified.' },
      )
      await ask(user, adding ? '请给当前页打上合适的标签' : 'This page no longer needs its sample tag')
      expect(await screen.findByText('Label state verified.')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
      expect(writes(browser)).toHaveLength(1)
      const [write] = writes(browser)
      expect(write?.init?.method).toBe(adding ? 'POST' : 'DELETE')
      if (adding) expect(write?.init?.body).toBe(JSON.stringify([{ prefix: 'global', name: 'sample-label' }]))
      else expect(new URL(write!.url).searchParams.get('name')).toBe('sample-label')
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
      expect(toolText(browser)).toContain(`"present":${adding}`)
      expect(toolText(browser)).toContain('"changed":true')
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-006-S03] reports when Confluence denies permission to change a label', async () => {
    const { browser, user } = await panel()
    browser.confluenceResponse = (url, init) => {
      if (new URL(url).pathname !== labelPath) return Response.json(current)
      if (init?.method === 'POST') return new Response(null, { status: 403 })
      return Response.json({ results: [] })
    }
    browser.ai.script.push({ toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] })
    await ask(user, 'Add label sample-label')
    await answered()
    expect(screen.getAllByText(/does not have permission/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
    expect(screen.queryByRole('img', { name: 'Done' })).not.toBeInTheDocument()
  })

  it.each([500, 429])(
    '[UC-CONFLUCO-CONFLUENCE-006-S04] stops without retrying after a successful write whose read-back fails (%s)',
    async (status) => {
      const { browser, user } = await panel()
      let written = false
      browser.confluenceResponse = (url, init) => {
        if (new URL(url).pathname !== labelPath) return Response.json(current)
        if (init?.method === 'POST') {
          written = true
          return Response.json({ results: [label] })
        }
        return written ? new Response(null, { status }) : Response.json({ results: [] })
      }
      browser.ai.script.push({ toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] })
      await ask(user, 'Add label sample-label')
      await answered()
      expect(screen.getAllByText(/result could not be verified/).length).toBeGreaterThan(0)
      if (status === 429) expect(screen.getAllByText(/rate-limited/).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(1)
      expect(browser.ai.calls).toHaveLength(1)
    },
  )

  it('[@no-uc:data] does not write a label after the target tab navigates to another page', async () => {
    const { browser, user } = await panel()
    let release!: () => void
    const canRead = new Promise<void>((resolve) => (release = resolve))
    browser.confluenceResponse = async (url) => {
      if (new URL(url).pathname !== labelPath) return Response.json(current)
      await canRead
      return Response.json({ results: [] })
    }
    browser.ai.script.push({ toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] })
    await ask(user, 'Add label sample-label')
    await waitFor(() =>
      expect(browser.workspaceRequests.some(({ url }) => new URL(url).pathname === labelPath)).toBe(true),
    )
    browser.selectTab({ id: 1, url: base + '/pages/viewpage.action?pageId=88', title: 'Different page' })
    release()
    await answered()
    expect(screen.getAllByText(/The Confluence tab changed/).length).toBeGreaterThan(0)
    expect(writes(browser)).toEqual([])
  })

  it('[UC-CONFLUCO-CONFLUENCE-006-S04] shows an uncertain write warning when Stop interrupts a dispatched write', async () => {
    const { browser, user } = await panel()
    browser.confluenceResponse = (url, init) => {
      if (new URL(url).pathname !== labelPath) return Response.json(current)
      if (init?.method !== 'POST') return Response.json({ results: [] })
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }
    browser.ai.script.push({ toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] })
    await ask(user, 'Add label sample-label')
    await waitFor(() => expect(writes(browser)).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText(/Some changes in this question may already have been made/)).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
  })

  it('[@no-uc:data] reports a later failure without a write warning when the label was already present', async () => {
    const { browser, user } = await panel()
    browser.confluenceResponse = (url) => {
      const endpoint = new URL(url)
      if (endpoint.pathname === labelPath) return Response.json({ results: [label] })
      if (endpoint.searchParams.get('expand') === 'operations') return new Response(null, { status: 403 })
      return Response.json(current)
    }
    browser.ai.script.push(
      { toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] },
      { toolCalls: [tool('get_page_access')] },
    )
    await ask(user, 'Add label sample-label')
    await answered()
    expect(screen.getAllByText(/does not have permission/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Some changes in this question may already have been made/)).not.toBeInTheDocument()
    expect(writes(browser)).toEqual([])
  })

  it('[@no-uc:access] does not change a label on a page no Confluence tool returned', async () => {
    const { browser, user } = await panel()
    browser.ai.script.push(
      {
        toolCalls: [
          tool('change_page_label', { action: 'add', label: label.name, page: { id: '88', instance: base } }),
        ],
      },
      { reply: 'No label was changed.' },
    )
    await ask(user, 'Tag that page too')
    expect(await screen.findByText('No label was changed.')).toBeVisible()
    expect(toolText(browser)).toContain('Use a page reference returned by a Confluence tool')
    expect(browser.workspaceRequests).toEqual([])
  })

  it('[@no-uc:wiring] lists the labels of a page named by a link on this site', async () => {
    const { browser, user } = await panel()
    const other = { ...current, id: '43', title: 'Other page' }
    browser.confluenceResponse = (url) =>
      new URL(url).pathname.endsWith('/label') ? Response.json({ results: [label] }) : Response.json(other)
    browser.ai.script.push(
      { toolCalls: [tool('list_page_labels', { page: base + '/pages/viewpage.action?pageId=43' })] },
      { reply: 'The other page has one label.' },
    )
    await ask(user, 'Which labels does the other page have?')
    expect(await screen.findByText('The other page has one label.')).toBeVisible()
    expect(browser.workspaceRequests.map(({ url }) => new URL(url).pathname)).toContain('/kb/rest/api/content/43/label')
    expect(toolText(browser)).toContain('"name":"sample-label"')
  })
})

it('[UC-CONFLUCO-CONFLUENCE-006-S07] verifies each of several label changes on its page', async () => {
  const { browser, user } = await panel()
  const old = { name: 'old-marker', prefix: 'global' }
  const other = { ...current, id: '43', title: 'Other page' }
  const labels: Record<string, (typeof label)[]> = { '42': [], '43': [old] }
  browser.confluenceResponse = (url, init) => {
    const endpoint = new URL(url)
    const id = /^\/kb\/rest\/api\/content\/(\d+)\/label$/.exec(endpoint.pathname)?.[1]
    if (!id) return Response.json(endpoint.pathname.endsWith('/43') ? other : current)
    if (init?.method === 'POST') labels[id] = [...labels[id]!, label]
    if (init?.method === 'DELETE')
      labels[id] = labels[id]!.filter(({ name }) => name !== endpoint.searchParams.get('name'))
    return Response.json({ results: labels[id] })
  }
  browser.ai.script.push(
    { toolCalls: [tool('change_page_label', { action: 'add', label: label.name })] },
    {
      toolCalls: [
        tool('change_page_label', {
          action: 'remove',
          label: old.name,
          page: base + '/pages/viewpage.action?pageId=43',
        }),
      ],
    },
    { reply: 'Both labels verified.' },
  )
  await ask(user, 'Move the marker label from the other page to this one')
  expect(await screen.findByText('Both labels verified.')).toBeVisible()
  expect(writes(browser).map(({ url, init }) => [init?.method, new URL(url).pathname])).toEqual([
    ['POST', labelPath],
    ['DELETE', '/kb/rest/api/content/43/label'],
  ])
  expect(labels).toEqual({ '42': [label], '43': [] })
  // Each card names the page it changes, which need not be the open one.
  expect(screen.getByText(/Remove the label "old-marker" from "Other page"/)).toBeInTheDocument()
  expect(toolText(browser)).toContain('"present":true,"changed":true')
  expect(toolText(browser)).toContain('"present":false,"changed":true')
})

it('[UC-CONFLUCO-CONFLUENCE-005-S06] stops on invalid restriction data from a successful response', async () => {
  const { browser, user } = await panel()
  browser.confluenceResponse = (url) =>
    url.endsWith('/restriction/byOperation') ? Response.json({ unexpected: true }) : Response.json(current)
  browser.ai.script.push({ toolCalls: [tool('get_page_access')] })
  await ask(user, 'What access does this page have?')
  expect(
    await screen.findByText('Confluence did not return the expected page restrictions.', { selector: 'div' }),
  ).toBeVisible()
  expect(browser.ai.calls).toHaveLength(1)
})
