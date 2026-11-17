import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const wiki = 'https://team.atlassian.net/wiki'
const pages = '/wiki/api/v2/pages'
const move = '/wiki/rest/api/content/42/move/append/88'
const home = { id: '10', type: 'page' }
const formerParent = { id: '11', type: 'page' }
const body = '<p>Published <strong>source</strong> text.</p>'
const source = {
  id: '42',
  title: 'Source fixture',
  status: 'current',
  parentId: formerParent.id,
  spaceId: '17',
  version: { number: 3 },
  body: { storage: { value: body } },
  _links: { webui: '/spaces/TEST/pages/42/Source+fixture' },
}
const destination = {
  ...source,
  id: '88',
  title: 'Destination fixture',
  parentId: home.id,
  _links: { webui: '/spaces/TEST/pages/88/Destination+fixture' },
}
const duplicate = {
  ...source,
  id: '99',
  title: 'Copy fixture',
  parentId: destination.id,
  version: { number: 1 },
  _links: { webui: '/spaces/TEST/pages/99/Copy+fixture' },
}
const empty = { results: [] }
const noAccessRestriction = { restrictions: { user: empty, group: empty } }
const workspace = () => openWorkspace({ url: wiki + source._links.webui, title: source.title }, wiki)
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')
const results = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n')

async function ask(user: UserEvent, prompt: string) {
  await user.click(screen.getByRole('textbox', { name: 'Message' }))
  await user.paste(prompt)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

it.each(['move', 'copy', 'restriction', 'changed', 'receipt', 'attachment', 'cycle', 'folder'] as const)(
  '[UC-CONFLUCO-CONFLUENCE-011-S01] [UC-CONFLUCO-CONFLUENCE-011-S02] [UC-CONFLUCO-CONFLUENCE-011-S03] [UC-CONFLUCO-CONFLUENCE-011-S04] checks a Cloud organization plan (%s)',
  async (operation) => {
    const { browser, user } = await workspace()
    const copy = operation === 'copy' || operation === 'attachment'
    let current = source
    let sourceReads = 0
    browser.confluenceResponse = (url, init) => {
      const at = new URL(url)
      if (init?.method === 'PUT') {
        expect(at.pathname).toBe(move)
        expect(init.body).toBeUndefined()
        expect(screen.getByText(/Move "Source fixture".*under "Destination fixture"/)).toBeVisible()
        current = { ...current, parentId: destination.id }
        return Response.json({ pageId: operation === 'receipt' ? '43' : source.id })
      }
      if (init?.method === 'POST') {
        expect(at.pathname).toBe(pages)
        expect(JSON.parse(String(init.body))).toEqual({
          parentId: destination.id,
          spaceId: destination.spaceId,
          status: 'current',
          title: duplicate.title,
          body: { representation: 'storage', value: body },
        })
        expect(screen.getByText(/Copy the body of "Source fixture".*as "Copy fixture"/)).toBeVisible()
        return Response.json(duplicate)
      }
      if (at.pathname === pages + '/42') {
        if (++sourceReads === 2 && operation === 'changed') current = { ...source, version: { number: 4 } }
        return Response.json(current)
      }
      if (at.pathname === pages + '/88')
        return Response.json(operation === 'cycle' ? { ...destination, parentId: source.id } : destination)
      if (at.pathname === pages + '/99') return Response.json(duplicate)
      if (at.pathname === pages) return Response.json(empty)
      if (at.pathname === pages + '/42/ancestors')
        return Response.json({
          results: [home, operation === 'folder' ? { ...formerParent, type: 'folder' } : formerParent],
        })
      if (at.pathname === pages + '/88/ancestors')
        return Response.json({
          results: operation === 'cycle' ? [home, formerParent, { id: source.id, type: 'page' }] : [home],
        })
      if (at.pathname === pages + '/42/attachments')
        return Response.json(operation === 'attachment' ? { results: [{ id: 'att2' }] } : empty)
      expect(at.pathname).toMatch(/^\/wiki\/rest\/api\/content\/(11|42)\/restriction\/byOperation$/)
      return Response.json({
        read:
          operation === 'restriction'
            ? { restrictions: { user: { results: [{}] }, group: empty } }
            : noAccessRestriction,
        update: noAccessRestriction,
      })
    }
    const tool = { name: copy ? 'copy_page' : 'move_page', arguments: '{}' }
    browser.ai.script.push(
      { toolCalls: operation === 'receipt' ? [tool, tool] : [tool] },
      { reply: 'Organization checked.' },
    )
    const link = wiki + destination._links.webui
    await ask(user, copy ? `Copy this page under ${link} as "Copy fixture"` : `Move this page under ${link}`)
    await screen.findByRole('button', { name: 'Send' })
    if (operation === 'move' || operation === 'copy') {
      expect(writes(browser)).toHaveLength(1)
      expect(results(browser)).toContain(`"version":${copy ? 1 : 3},"changed":true`)
      expect(results(browser)).toContain(copy ? wiki + duplicate._links.webui : wiki + source._links.webui)
      expect(current.id).toBe(source.id)
      expect(current.parentId).toBe(copy ? formerParent.id : destination.id)
      expect(current.body.storage.value).toBe(body)
    } else if (operation === 'receipt') {
      expect(screen.getAllByText(/could not be verified/).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(1)
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('PUT')
    } else {
      const messages = {
        restriction: /could drop an existing access restriction/,
        changed: /changed after the preview/,
        attachment: /page has attachments/,
        cycle: /under itself or its descendants/,
        folder: /complete page-only hierarchy/,
      }
      expect(screen.getAllByText(messages[operation]).length).toBeGreaterThan(0)
      expect(writes(browser)).toEqual([])
    }
  },
)

it.each(['allowed', 'declined', 'children', 'unverified'])(
  '[UC-CONFLUCO-CONFLUENCE-012-S01] [UC-CONFLUCO-CONFLUENCE-012-S03] [UC-CONFLUCO-CONFLUENCE-012-S04] verifies or stops Cloud trash (%s)',
  async (outcome) => {
    const { browser, user } = await workspace()
    let trashed = false
    browser.confluenceResponse = (url, init) => {
      const at = new URL(url)
      if (init?.method === 'DELETE') {
        expect(at.pathname).toBe(pages + '/42')
        expect(at.search).toBe('')
        expect(init.body).toBeUndefined()
        trashed = true
        return new Response(null, { status: 204 })
      }
      if (at.pathname === pages + '/42/ancestors') return Response.json({ results: [home, formerParent] })
      if (at.pathname === pages + '/42/direct-children')
        return Response.json(outcome === 'children' ? { results: [{ id: '18', type: 'folder' }] } : empty)
      if (at.pathname.endsWith('/restriction/byOperation'))
        return Response.json({
          read: noAccessRestriction,
          update: noAccessRestriction,
        })
      expect(at.pathname).toBe(pages + '/42')
      if (trashed) {
        expect(at.searchParams.get('status')).toBe('trashed')
        return Response.json(outcome === 'unverified' ? source : { ...source, status: 'trashed', parentId: null })
      }
      return Response.json(source)
    }
    const trash = { name: 'trash_page', arguments: '{}' }
    browser.ai.script.push(
      { toolCalls: outcome === 'unverified' ? [trash, trash] : [trash] },
      { reply: 'Trash state checked.' },
    )
    await ask(user, 'Trash this page')
    if (outcome !== 'children') {
      const allow = await screen.findByRole('button', { name: 'Allow' })
      expect(writes(browser)).toEqual([])
      expect(screen.getByText(/A space admin can restore/)).toBeVisible()
      if (outcome === 'declined') await user.click(screen.getByRole('button', { name: 'Deny' }))
      else await user.click(allow)
    }
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(outcome === 'allowed' || outcome === 'unverified' ? 1 : 0)
    if (outcome === 'allowed') expect(results(browser)).toContain('"status":"trashed"')
    if (outcome === 'unverified')
      expect(screen.getAllByText(/Check the space trash before asking again/).length).toBeGreaterThan(0)
    if (outcome === 'children')
      expect(screen.getAllByText(/confirm that this page has no children/).length).toBeGreaterThan(0)
  },
)
