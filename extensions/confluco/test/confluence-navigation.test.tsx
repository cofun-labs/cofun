import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)
const address = (id: string) => base + '/pages/viewpage.action?pageId=' + id
const page = (id: string, title: string) => ({ id, title, type: 'page', status: 'current' })
const current = page('42', 'Fixture home')
const call = (name: string, args: object = {}) => ({
  toolCalls: [{ name, arguments: JSON.stringify(args) }],
})
const readData = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => content)
    .join('\n')

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

it('[UC-CONFLUCO-CONFLUENCE-004-S01] finds a space and its homepage from the same question', async () => {
  const { browser, user } = await openWorkspace({ url: address(current.id), title: current.title })
  const space = { key: 'FIX', name: 'Fixture space' }
  browser.confluenceResponse = (url) =>
    new URL(url).pathname.endsWith('/space')
      ? Response.json({ results: [space] })
      : Response.json({ ...space, homepage: current })
  browser.ai.script.push(call('list_spaces'), call('get_space', { key: 'FIX' }), { reply: 'Fixture space homepage.' })
  await ask(user, 'Find the fixture space and its homepage')
  expect(await screen.findByText('Fixture space homepage.')).toBeVisible()
  expect(browser.workspaceRequests.map(({ url }) => url)).toEqual([
    base + '/rest/api/space?start=0&limit=10',
    base + '/rest/api/space/FIX?expand=homepage',
  ])
  expect(readData(browser)).toContain('Fixture space')
  expect(readData(browser)).toContain(base + '/display/FIX')
  expect(readData(browser)).toContain(address('42'))
})

it.each([false, true])(
  '[UC-CONFLUCO-CONFLUENCE-004-S02] reads ancestors and children (reference %s)',
  async (reference) => {
    const { browser, user } = await openWorkspace({ url: address(current.id), title: current.title })
    browser.confluenceResponse = (url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/search')) return Response.json({ results: [{ content: current }] })
      if (path.endsWith('/child/page')) return Response.json({ results: [page('43', 'Child')] })
      return Response.json({ ...current, ancestors: [page('41', 'Parent')] })
    }
    if (reference) browser.ai.script.push(call('search_pages', { query: 'Fixture home' }))
    browser.ai.script.push(call('browse_page_tree', reference ? { page: { instance: base, id: '42' } } : {}), {
      reply: 'Parent and child.',
    })
    await ask(user, 'Find the page tree for Fixture home')
    expect(await screen.findByText('Parent and child.')).toBeVisible()
    expect(browser.workspaceRequests.slice(-2).map(({ url }) => url)).toEqual([
      base + '/rest/api/content/42?expand=ancestors',
      base + '/rest/api/content/42/child/page?start=0&limit=10',
    ])
    expect(readData(browser)).toContain(address('41'))
    expect(readData(browser)).toContain(address('43'))
  },
)

it.each([base, 'https://other.example.test/wiki'])(
  '[UC-CONFLUCO-CONFLUENCE-004-S03] never sends a request for an unreturned reference at %s',
  async (instance) => {
    const { browser, user } = await openWorkspace({ url: address(current.id), title: current.title })
    browser.ai.script.push(call('browse_page_tree', { page: { instance, id: '99' } }), {
      reply: 'Use a known page.',
    })
    await ask(user, 'Read the hierarchy for a page')
    expect(await screen.findByText('Use a known page.')).toBeVisible()
    expect(browser.workspaceRequests).toEqual([])
    expect(readData(browser)).toContain('Use a page reference returned by a Confluence tool')
  },
)

it('[UC-CONFLUCO-CONFLUENCE-004-S03] stops if a reference from a result has become inaccessible', async () => {
  const { browser, user } = await openWorkspace({ url: address(current.id), title: current.title })
  browser.confluenceResponse = (url) =>
    new URL(url).pathname.endsWith('/search')
      ? Response.json({ results: [{ content: current }] })
      : new Response(null, { status: 403 })
  browser.ai.script.push(
    call('search_pages', { query: 'Fixture home' }),
    call('browse_page_tree', { page: { instance: base, id: current.id } }),
  )
  await ask(user, 'Find the tree for Fixture home')
  expect(
    await screen.findByText('Your Confluence account does not have permission for this request.', { selector: 'div' }),
  ).toBeVisible()
  expect(browser.workspaceRequests).toHaveLength(2)
})
