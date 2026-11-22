import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)
const wiki = 'https://team.atlassian.net/wiki'
const endpoint = '/wiki/api/v2/pages/42'
const text = '<p>Before this. Keep &amp; <strong>formatting</strong>.</p>'
const changed = '<p>After this. Keep &amp; <strong>formatting</strong>.</p>'
const page = {
  id: '42',
  title: 'Recovery fixture',
  status: 'current',
  spaceId: '17',
  parentId: '10',
  version: { number: 2 },
  body: { storage: { value: text } },
  _links: { webui: '/spaces/TEST/pages/42/Recovery+fixture' },
}
const link = wiki + page._links.webui
const call = (name: string) => ({ name, arguments: '{}' })
const workspace = () => openWorkspace({ url: link, title: page.title }, wiki)
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')
const toolText = (browser: WorkspaceBrowser) =>
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

it.each(['edit', 'newer', 'ambiguous', 'signed out', 'uncertain'] as const)(
  '[UC-CONFLUCO-CONFLUENCE-009-S01] [UC-CONFLUCO-CONFLUENCE-009-S02] [UC-CONFLUCO-CONFLUENCE-009-S03] [UC-CONFLUCO-CONFLUENCE-009-S04] [UC-CONFLUCO-CONFLUENCE-009-S09] applies only a requested Cloud text edit (%s)',
  async (outcome) => {
    const { browser, user } = await workspace()
    let current = outcome === 'ambiguous' ? { ...page, body: { storage: { value: text + text } } } : page
    let reads = 0
    browser.confluenceResponse = (url, init) => {
      expect(new URL(url).pathname).toBe(endpoint)
      if (init?.method === 'PUT') {
        expect(screen.getByText(/Before: "Before"/)).toHaveTextContent('After: "After"')
        expect(JSON.parse(String(init?.body))).toEqual({
          id: page.id,
          status: 'current',
          title: page.title,
          version: { number: 3 },
          body: { representation: 'storage', value: changed },
        })
        if (outcome === 'signed out') return new Response(null, { status: 401 })
        current = { ...page, version: { number: 3 }, body: { storage: { value: changed } } }
        return outcome === 'uncertain' ? new Response(null, { status: 503 }) : Response.json(current)
      }
      if (++reads === 2 && outcome === 'newer') current = { ...page, version: { number: 3 } }
      return Response.json(current)
    }
    const edit = call('edit_page')
    browser.ai.script.push({ toolCalls: outcome === 'signed out' ? [edit, edit] : [edit] }, { reply: 'Edit checked.' })
    await ask(user, 'Replace "Before" with "After" on this page')
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(outcome === 'newer' || outcome === 'ambiguous' ? 0 : 1)
    if (outcome === 'edit' || outcome === 'uncertain') expect(toolText(browser)).toContain('"bodyVerified":true')
    if (outcome === 'newer') expect(screen.getAllByText(/changed after the preview/).length).toBeGreaterThan(0)
    if (outcome === 'signed out') {
      expect(screen.getAllByText(/Sign in to Confluence/).length).toBeGreaterThan(0)
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('PUT')
    }
    if (outcome === 'uncertain') expect(toolText(browser)).toContain('"recovered":true')
  },
)

it.each([
  'restore',
  'redirect',
  'declined',
  'wrong id',
  'wrong action',
  'redirected form',
  'no token',
  'denied',
  'uncertain',
] as const)(
  '[UC-CONFLUCO-CONFLUENCE-012-S02] [UC-CONFLUCO-CONFLUENCE-012-S03] [UC-CONFLUCO-CONFLUENCE-012-S04] checks the Cloud native restore form and result (%s)',
  async (outcome) => {
    const { browser, user } = await workspace()
    let current = { ...page, status: 'trashed' }
    browser.confluenceResponse = (url, init) => {
      const at = new URL(url)
      if (at.pathname === endpoint) return Response.json(current)
      if (at.pathname === '/wiki/api/v2/spaces/17') return Response.json({ id: '17', key: 'TEST' })
      if (at.pathname === '/wiki/pages/restoretrashitem.action') {
        expect(init?.method).toBe('GET')
        expect(at.searchParams.get('contentId')).toBe(page.id)
        expect(at.searchParams.get('key')).toBe('TEST')
        if (outcome === 'redirected form')
          return new Response(null, { status: 302, headers: { Location: '/wiki/login.action' } })
        return new Response(
          `<form method="post" action="${outcome === 'wrong action' ? 'https://other.example.test/restore' : '/wiki/pages/dorestoretrashitem.action'}">
          <input name="key" value="TEST"><input name="contentId" value="${outcome === 'wrong id' ? '43' : page.id}">
          ${outcome === 'no token' ? '' : '<input name="atl_token" value="synthetic-csrf-value">'}
          <input type="submit" name="confirm" value="OK"></form>`,
          { headers: { 'Content-Type': 'text/html' } },
        )
      }
      expect(at.pathname).toBe('/wiki/pages/dorestoretrashitem.action')
      expect(init?.method).toBe('POST')
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
      expect([...new URLSearchParams(String(init?.body)).entries()]).toEqual([
        ['atl_token', 'synthetic-csrf-value'],
        ['key', 'TEST'],
        ['contentId', page.id],
        ['confirm', 'OK'],
      ])
      if (outcome === 'denied') return new Response(null, { status: 403 })
      if (outcome !== 'uncertain') current = { ...page, parentId: '0' }
      if (outcome === 'redirect')
        return new Response(null, { status: 302, headers: { Location: '/wiki/spaces/TEST/overview' } })
      return new Response('<p>Native action finished</p>', { headers: { 'Content-Type': 'text/html' } })
    }
    const restore = call('restore_page')
    browser.ai.script.push({ toolCalls: [restore, restore] }, { reply: 'Recovery checked.' })
    await ask(user, 'Restore page ' + link)
    const allow = await screen.findByRole('button', { name: 'Allow' })
    expect(writes(browser)).toEqual([])
    await user.click(outcome === 'declined' ? screen.getByRole('button', { name: 'Deny' }) : allow)
    await screen.findByRole('button', { name: 'Send' })
    const attempted = ['restore', 'redirect', 'denied', 'uncertain'].includes(outcome)
    expect(writes(browser)).toHaveLength(attempted ? 1 : 0)
    expect(JSON.stringify(browser.sentToModel())).not.toContain('synthetic-csrf-value')
    if (['wrong id', 'wrong action', 'redirected form', 'no token'].includes(outcome)) {
      expect(screen.getAllByText(/could not prepare the restore confirmation/).length).toBeGreaterThan(0)
      expect(new URL(browser.workspaceRequests.at(-1)!.url).pathname).toBe('/wiki/pages/restoretrashitem.action')
      expect(browser.workspaceRequests.filter(({ url }) => new URL(url).pathname === endpoint)).toHaveLength(2)
    }

    if (outcome === 'restore' || outcome === 'redirect')
      expect(toolText(browser)).toContain('"changed":true,"atSpaceRoot":true')
    if (outcome === 'denied') {
      expect(screen.getAllByText(/does not have permission/).length).toBeGreaterThan(0)
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('POST')
    }
    if (outcome === 'uncertain') expect(screen.getAllByText(/Check the page or space trash/).length).toBeGreaterThan(0)
  },
)
