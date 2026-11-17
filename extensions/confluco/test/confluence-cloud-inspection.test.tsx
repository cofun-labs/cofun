import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { closeWorkspace, followConfluencePage, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

const origin = 'https://team.atlassian.net'
const cloud = origin + '/wiki'
const pagePath = '/wiki/api/v2/pages/42'
const page = {
  id: '42',
  title: 'Cloud lesson',
  status: 'current',
  _links: { webui: '/spaces/SCHOOL/pages/42/Cloud+lesson' },
}
const parent = { id: '13', title: 'Cloud parent', status: 'current' }
const child = { id: '54', title: 'Cloud child', status: 'current' }
const workspace = () => openWorkspace({ url: origin + '/wiki' + page._links.webui, title: page.title }, cloud)
const call = (name: string, args: object = {}) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

afterEach(closeWorkspace)

async function ask(user: Awaited<ReturnType<typeof workspace>>['user'], text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const toolText = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n')

it('[UC-CONFLUCO-CONFLUENCE-004-S01] [UC-CONFLUCO-CONFLUENCE-004-S02] browses Cloud spaces and only published pages in the tree', async () => {
  const { browser, user } = await workspace()
  const space = { id: '33', key: 'SCHOOL', name: 'Cloud lessons', homepageId: '13' }
  browser.confluenceResponse = (url) => {
    const endpoint = new URL(url)
    switch (endpoint.pathname) {
      case '/wiki/api/v2/spaces':
        return Response.json({ results: [space] })
      case '/wiki/api/v2/pages/13':
        return Response.json(parent)
      case pagePath:
        return Response.json(page)
      case pagePath + '/ancestors':
        return Response.json({
          results: [
            { id: '13', type: 'page' },
            { id: '14', type: 'folder' },
          ],
        })
      case pagePath + '/direct-children':
        return Response.json({
          results: [
            { id: '54', type: 'page' },
            { id: '7', type: 'whiteboard' },
          ],
        })
      case '/wiki/api/v2/pages': {
        const ids = endpoint.searchParams.getAll('id')
        return Response.json({ results: [parent, child].filter((item) => ids.includes(item.id)) })
      }
    }
    return new Response(null, { status: 404 })
  }
  browser.ai.script.push(call('list_spaces'), call('get_space', { key: 'SCHOOL' }), call('browse_page_tree'), {
    reply: 'Cloud tree ready.',
  })
  await ask(user, 'Browse the Cloud space and page tree.')
  expect(await screen.findByText('Cloud tree ready.')).toBeVisible()
  const output = toolText(browser)
  expect(output).toContain('Cloud lessons')
  expect(output).toContain('"homepage":{"title":"Cloud parent"')
  expect(output).toContain('"ancestors":[{"title":"Cloud parent"')
  expect(output).toContain('"children":[{"title":"Cloud child"')
  expect(
    browser.workspaceRequests.every(({ url, init }) => new URL(url).origin === origin && init?.method === 'GET'),
  ).toBe(true)
})

it('[UC-CONFLUCO-CONFLUENCE-005-S01] [UC-CONFLUCO-CONFLUENCE-005-S02] [UC-CONFLUCO-CONFLUENCE-005-S04] reads Cloud versions and reported restrictions', async () => {
  const { browser, user } = await workspace()
  const version = { number: 2, createdAt: '2026-11-13T00:00:00Z', message: 'Current fixture' }
  const restrictions = (count: number) => ({
    restrictions: {
      user: { results: Array.from({ length: count }, () => ({ displayName: 'Private name' })) },
      group: { results: [] },
    },
  })
  browser.confluenceResponse = (url) => {
    const endpoint = new URL(url)
    switch (endpoint.pathname) {
      case pagePath:
        return Response.json(
          endpoint.searchParams.has('version')
            ? {
                ...page,
                status: 'historical',
                version: { number: 1 },
                body: { view: { value: '<p>Earlier Cloud body.</p>' } },
              }
            : { ...page, version },
        )
      case pagePath + '/versions':
        return Response.json({ results: [version, { number: 1, message: 'Earlier version' }] })
      case pagePath + '/operations':
        return Response.json({ operations: [{ operation: 'read', targetType: 'page' }] })
      case '/wiki/rest/api/content/42/restriction/byOperation':
        return Response.json({ read: restrictions(0), update: restrictions(1) })
    }
    return new Response(null, { status: 404 })
  }
  browser.ai.script.push(
    call('list_page_versions'),
    call('read_page_version', { version: 1 }),
    call('get_page_access'),
    { reply: 'Cloud history ready.' },
  )
  await ask(user, 'Inspect the history and access.')
  expect(await screen.findByText('Cloud history ready.')).toBeVisible()
  const output = toolText(browser)
  expect(output).toContain('Earlier version')
  expect(output).toContain('Earlier Cloud body.')
  expect(output).toContain('"restrictions":{"read":false,"update":true}')
  expect(output).not.toContain('Private name')
})

it('[UC-CONFLUCO-CONFLUENCE-006-S01] [UC-CONFLUCO-CONFLUENCE-010-S01] [UC-CONFLUCO-CONFLUENCE-013-S01] reads Cloud labels, discussion replies, inline comments and attachments', async () => {
  const { browser, user } = await workspace()
  const comment = (id: string, value: string, parentCommentId?: string) => ({
    id,
    pageId: '42',
    parentCommentId,
    body: { storage: { value } },
  })
  browser.confluenceResponse = (url) => {
    const endpoint = new URL(url)
    switch (endpoint.pathname) {
      case pagePath:
        return Response.json(page)
      case pagePath + '/labels':
        return Response.json({ results: [{ prefix: 'global', name: 'agenda' }] })
      case pagePath + '/footer-comments':
        return Response.json({ results: [comment('101', '<p>Footer question</p>')] })
      case '/wiki/api/v2/footer-comments/101/children':
        return Response.json({ results: [comment('102', '<p>Footer response</p>', '101')] })
      case '/wiki/api/v2/footer-comments/102/children':
        return Response.json({ results: [] })
      case pagePath + '/inline-comments':
        return Response.json({ results: [comment('103', '<p>Inline discussion</p>')] })
      case '/wiki/api/v2/inline-comments/103/children':
        return Response.json({ results: [] })
      case pagePath + '/attachments':
        if (endpoint.searchParams.get('filename') !== 'agenda.txt') return new Response(null, { status: 400 })
        return Response.json({
          results: [
            {
              id: 'att55',
              title: 'agenda.txt',
              pageId: '42',
              version: { number: 2 },
              downloadLink: '/download/attachments/42/agenda.txt?version=2',
              fileSize: 30,
            },
          ],
        })
    }
    return new Response(null, { status: 404 })
  }
  browser.ai.script.push(call('list_page_labels'), call('list_page_comments'))
  function continueComments(remaining: number) {
    followConfluencePage(browser, (nextPage) => {
      browser.ai.script.push(call('list_page_comments', { nextPage }))
      if (remaining > 1) continueComments(remaining - 1)
      else
        browser.ai.script.push(call('list_page_attachments', { filename: 'agenda.txt' }), {
          reply: 'Cloud details ready.',
        })
    })
  }
  continueComments(4)
  await ask(user, 'Inspect labels and comments and find agenda.txt.')
  expect(await screen.findByText('Cloud details ready.')).toBeVisible()
  const output = toolText(browser)
  expect(output).toContain('"name":"agenda"')
  expect(output).toContain('Footer question')
  expect(output).toContain('Footer response')
  expect(output).toContain('"parentId":"101"')
  expect(output).toContain('Inline discussion')
  expect(output).toContain(cloud + '/download/attachments/42/agenda.txt?version=2&download=true')
})
