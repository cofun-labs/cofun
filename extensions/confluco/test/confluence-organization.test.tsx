import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const url = (id: string) => base + '/pages/viewpage.action?pageId=' + id
const api = '/kb/rest/api/content'
const source = {
  id: '42',
  title: 'Source fixture',
  type: 'page',
  status: 'current',
  space: { key: 'TEST' },
  ancestors: [{ id: '20' }],
  version: { number: 2 },
  body: {
    storage: {
      value: '<p>Keep content</p><table><tbody><tr><td>Table cell</td></tr></tbody></table>',
      representation: 'storage',
    },
  },
}
const parent = { ...source, id: '77', title: 'Destination fixture' }
const moved = { ...source, ancestors: [...parent.ancestors, { id: parent.id }], version: { number: 3 } }
const copied = { ...moved, id: '99', title: 'Copy fixture', version: { number: 1 } }
const empty = { results: [] }
const unrestricted = { restrictions: { user: empty, group: empty } }
const move = { name: 'move_page', arguments: JSON.stringify({ parent: url('77') }) }
const copy = { name: 'copy_page', arguments: JSON.stringify({ parent: url('77'), title: 'Copy fixture' }) }
const moveQuestion = 'File this page under the destination page'
const copyQuestion = 'Make a copy of this page under the destination page'

async function openPanel() {
  const { browser, user } = await openWorkspace({ url: url(source.id), title: source.title })
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}
const answered = () => screen.findByRole('button', { name: 'Send' })
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')
const results = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => content)
    .join('\n')

describe('organize published pages', () => {
  it('[UC-CONFLUCO-CONFLUENCE-011-S01] moves the same page and verifies its new parent and body', async () => {
    const { browser, user } = await openPanel()
    let done = false
    browser.confluenceResponse = (address, init) => {
      const path = new URL(address).pathname
      if (path.endsWith('/77')) return Response.json(parent)
      if (init?.method === 'PUT') {
        expect(path).toBe(api + '/42')
        expect(screen.getByText(/Move "Source fixture".*under "Destination fixture"/)).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
        expect(init.body).toBe(
          JSON.stringify({
            type: 'page',
            title: source.title,
            space: source.space,
            version: { number: 3 },
            ancestors: [{ id: '77' }],
            body: source.body,
          }),
        )
        done = true
      }
      return Response.json(done ? moved : source)
    }
    browser.ai.script.push({ toolCalls: [move] }, { reply: 'Move verified.' })
    await ask(user, moveQuestion)
    expect(await screen.findByText('Move verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(results(browser)).toContain(url('42'))
    expect(results(browser)).toContain(url('77'))
    expect(results(browser)).toContain('"version":3,"changed":true')
  })

  it('[UC-CONFLUCO-CONFLUENCE-011-S02] verifies a distinct copy beneath the chosen parent', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (address, init) => {
      const path = new URL(address).pathname
      if (init?.method === 'POST') {
        expect(screen.getByText(/Copy the body of "Source fixture".*as "Copy fixture"/)).toBeVisible()
        expect(init.body).toBe(
          JSON.stringify({
            type: 'page',
            title: copied.title,
            space: source.space,
            ancestors: [{ id: '77' }],
            body: source.body,
          }),
        )
        return Response.json(copied)
      }
      if (path.endsWith('/77')) return Response.json(parent)
      if (path.endsWith('/99')) return Response.json(copied)
      if (path.endsWith('/restriction/byOperation')) return Response.json({ read: unrestricted, update: unrestricted })
      if (path.endsWith('/child/attachment') || path === api) return Response.json(empty)
      return Response.json(source)
    }
    browser.ai.script.push({ toolCalls: [copy] }, { reply: 'Copy verified.' })
    await ask(user, copyQuestion)
    expect(await screen.findByText('Copy verified.')).toBeVisible()
    expect(writes(browser)).toHaveLength(1)
    expect(results(browser)).toContain(url('99'))
    expect(results(browser)).toContain(url('77'))
  })

  it.each([
    ['a parent in another space', { ...parent, space: { key: 'OTHER' } }, false, /same Confluence space/],
    ['a parent under the page', { ...parent, ancestors: [{ id: '42' }] }, false, /under itself or its descendants/],
    ['a lost restriction', { ...parent, ancestors: [{ id: '30' }] }, true, /drop an existing page restriction/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-011-S03] refuses a move to %s and tells the model why',
    async (_case, destination, hasRestriction, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (address) => {
        const path = new URL(address).pathname
        if (path.endsWith('/77')) return Response.json(destination)
        if (path.endsWith('/restriction/byOperation') && hasRestriction)
          return Response.json({
            read: { restrictions: { user: { results: [{}] }, group: empty } },
            update: unrestricted,
          })
        return Response.json(source)
      }
      browser.ai.script.push({ toolCalls: [move] }, { reply: 'The page stays where it is.' })
      await ask(user, moveQuestion)
      expect(await screen.findByText('The page stays where it is.')).toBeVisible()
      expect(results(browser)).toMatch(reason)
      expect(writes(browser)).toEqual([])
    },
  )

  it.each([false, true])(
    '[UC-CONFLUCO-CONFLUENCE-011-S04] stops on a changed destination or uncertain move (%s)',
    async (uncertain) => {
      const { browser, user } = await openPanel()
      let destinationReads = 0
      browser.confluenceResponse = (address, init) => {
        if (init?.method === 'PUT') return new Response(null, { status: 503 })
        if (new URL(address).pathname.endsWith('/77')) {
          destinationReads++
          return Response.json(uncertain || destinationReads === 1 ? parent : { ...parent, title: 'Moved destination' })
        }
        return Response.json(source)
      }
      browser.ai.script.push({ toolCalls: [move, move] })
      await ask(user, moveQuestion)
      await answered()
      expect(
        screen.getAllByText(uncertain ? /change may have been applied/ : /destination changed after the preview/)
          .length,
      ).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(uncertain ? 1 : 0)
    },
  )

  const restricted = { restrictions: { user: { results: [{}] }, group: empty } }
  it.each([
    ['a source read restriction', { read: restricted }, {}, false, /drop an existing page restriction/],
    ['a source update restriction', { update: restricted }, {}, false, /drop an existing page restriction/],
    [
      'an attachment reference',
      {},
      { value: '<p><ri:attachment ri:filename="file.pdf" /></p>' },
      false,
      /attachment or inline comment references/,
    ],
    [
      'an inline comment reference',
      {},
      { value: '<ac:inline-comment-marker ac:ref="test">Text</ac:inline-comment-marker>' },
      false,
      /attachment or inline comment references/,
    ],
    ['attachments', {}, {}, true, /page has attachments/],
    ['a title already used', {}, {}, false, /title already exists/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-011-S03] refuses a copy of a page with %s and tells the model why',
    async (outcome, access, storage, hasAttachments, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (address) => {
        const path = new URL(address).pathname
        if (path.endsWith('/77')) return Response.json(parent)
        if (path.endsWith('/child/attachment')) return Response.json(hasAttachments ? { results: [{}] } : empty)
        if (path.endsWith('/42/restriction/byOperation'))
          return Response.json({ read: unrestricted, update: unrestricted, ...access })
        if (path === api) return Response.json(outcome === 'a title already used' ? { results: [copied] } : empty)
        return Response.json({ ...source, body: { storage: { ...source.body.storage, ...storage } } })
      }
      browser.ai.script.push({ toolCalls: [copy] }, { reply: 'No copy was made.' })
      await ask(user, copyQuestion)
      expect(await screen.findByText('No copy was made.')).toBeVisible()
      expect(results(browser)).toMatch(reason)
      expect(writes(browser)).toEqual([])
    },
  )

  it.each(['source changed', 'invalid create response', 'copy read-back mismatch'])(
    '[UC-CONFLUCO-CONFLUENCE-011-S04] stops a copy on %s',
    async (outcome) => {
      const { browser, user } = await openPanel()
      let sourceReads = 0
      browser.confluenceResponse = (address, init) => {
        const path = new URL(address).pathname
        if (path.endsWith('/77')) return Response.json(parent)
        if (path.endsWith('/restriction/byOperation'))
          return Response.json({ read: unrestricted, update: unrestricted })
        if (path.endsWith('/child/attachment')) return Response.json(empty)
        if (init?.method === 'POST')
          return Response.json(outcome === 'invalid create response' ? { title: copied.title } : copied)
        if (path === api) return Response.json(empty)
        if (path.endsWith('/99')) return Response.json({ ...copied, ancestors: [] })
        sourceReads++
        return Response.json(
          outcome === 'source changed' && sourceReads > 1 ? { ...source, version: { number: 3 } } : source,
        )
      }
      browser.ai.script.push({ toolCalls: [copy, copy] })
      await ask(user, copyQuestion)
      await answered()
      const reason = outcome === 'source changed' ? /changed after the preview/ : /could not be verified/
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(outcome === 'source changed' ? 0 : 1)
    },
  )
})
