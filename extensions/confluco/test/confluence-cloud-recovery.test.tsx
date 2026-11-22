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
const edit = { name: 'edit_page', arguments: JSON.stringify({ before: 'Before', after: 'After' }) }
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
  '[UC-CONFLUCO-CONFLUENCE-009-S01] [UC-CONFLUCO-CONFLUENCE-009-S02] [UC-CONFLUCO-CONFLUENCE-009-S03] [UC-CONFLUCO-CONFLUENCE-009-S04] [UC-CONFLUCO-CONFLUENCE-009-S09] applies only the passage the model replaces on Cloud (%s)',
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
    browser.ai.script.push({ toolCalls: outcome === 'signed out' ? [edit, edit] : [edit] }, { reply: 'Edit checked.' })
    await ask(user, 'Tidy the opening sentence of this page')
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(outcome === 'newer' || outcome === 'ambiguous' ? 0 : 1)
    if (outcome === 'edit' || outcome === 'uncertain') expect(toolText(browser)).toContain('"bodyVerified":true')
    // A passage that is not unique goes back to the model, and the question goes on.
    if (outcome === 'ambiguous') {
      expect(toolText(browser)).toContain('appears more than once')
      expect(await screen.findByText('Edit checked.')).toBeVisible()
    }
    if (outcome === 'newer') expect(screen.getAllByText(/changed after the preview/).length).toBeGreaterThan(0)
    if (outcome === 'signed out') {
      expect(screen.getAllByText(/Sign in to Confluence/).length).toBeGreaterThan(0)
      expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('PUT')
    }
    if (outcome === 'uncertain') expect(toolText(browser)).toContain('"recovered":true')
  },
)
