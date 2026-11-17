import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const wiki = 'https://team.atlassian.net/wiki'
const pages = '/wiki/api/v2/pages'
const comments = '/wiki/api/v2/footer-comments'
const labelPath = '/wiki/rest/api/content/42/label'
const storage = (value: string) => ({ representation: 'storage', value })
const page = {
  id: '42',
  status: 'current',
  title: 'Parent fixture',
  spaceId: '17',
  parentId: '10',
  body: { storage: storage('<p>Keep this text.</p>') },
  version: { number: 2 },
  _links: { webui: '/spaces/TEST/pages/42/Parent+fixture' },
}
const child = {
  ...page,
  id: '99',
  parentId: page.id,
  title: 'Child fixture',
  version: { number: 1 },
  body: { storage: storage('<p>Literal &lt;tag&gt; &amp; text</p>') },
  _links: { webui: '/spaces/TEST/pages/99/Child+fixture' },
}
const workspace = () => openWorkspace({ url: wiki + page._links.webui, title: page.title }, wiki)
const call = (name: string, args = {}) => ({ name, arguments: JSON.stringify(args) })
const writes = (browser: WorkspaceBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method !== 'GET')
const results = (browser: WorkspaceBrowser) =>
  browser
    .sentToModel()
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n')

async function ask(user: UserEvent, message: string) {
  await user.click(screen.getByRole('textbox', { name: 'Message' }))
  await user.paste(message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

it.each(['created', 'duplicate', 'rejected', 'denied', 'uncertain'])(
  '[UC-CONFLUCO-CONFLUENCE-007-S01] [UC-CONFLUCO-CONFLUENCE-007-S02] [UC-CONFLUCO-CONFLUENCE-007-S03] verifies a Cloud creation or stops on %s',
  async (outcome) => {
    const { browser, user } = await workspace()
    browser.confluenceResponse = (url, init) => {
      const target = new URL(url)
      if (init?.method === 'POST') {
        expect(target.pathname).toBe(pages)
        expect(screen.getByText(/Create "Child fixture" under "Parent fixture"/)).toBeVisible()
        expect(JSON.parse(String(init.body))).toEqual({
          spaceId: page.spaceId,
          parentId: page.id,
          status: 'current',
          title: child.title,
          body: child.body.storage,
        })
        if (outcome === 'rejected') return new Response(null, { status: 400 })
        if (outcome === 'denied') return new Response(null, { status: 403 })
        return Response.json(child)
      }
      if (target.pathname === pages) {
        expect(target.searchParams.get('title')).toBe(child.title)
        expect(target.searchParams.get('space-id')).toBe(page.spaceId)
        return Response.json({ results: outcome === 'duplicate' ? [child] : [] })
      }
      if (target.pathname === pages + '/99')
        return Response.json(outcome === 'uncertain' ? { ...child, parentId: '10' } : child)
      expect(target.pathname).toBe(pages + '/42')
      return Response.json(page)
    }
    const create = call('create_page', { title: child.title })
    browser.ai.script.push(
      { toolCalls: ['rejected', 'denied', 'uncertain'].includes(outcome) ? [create, create] : [create] },
      { reply: 'Finished checking creation.' },
    )
    await ask(user, 'Create page "Child fixture" under this page with text "Literal <tag> & text"')
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(outcome === 'duplicate' ? 0 : 1)
    if (outcome === 'created') expect(results(browser)).toContain('"bodyVerified":true')
    if (outcome === 'duplicate') expect(results(browser)).toContain('"alreadyExists":true')
    if (outcome === 'rejected') expect(screen.getAllByText(/title is valid and unique/).length).toBeGreaterThan(0)
    if (outcome === 'denied') expect(screen.queryAllByText(/does not have permission/).length).toBeGreaterThan(0)
    if (outcome === 'uncertain') expect(screen.queryAllByText(/could not be verified/).length).toBeGreaterThan(0)
  },
)

it.each([false, true])(
  '[UC-CONFLUCO-CONFLUENCE-008-S01] [UC-CONFLUCO-CONFLUENCE-008-S02] renames only the reviewed Cloud revision (concurrent change %s)',
  async (changedBeforeWrite) => {
    const { browser, user } = await workspace()
    const renamed = { ...page, title: 'Renamed fixture', version: { number: 3 } }
    let count = 0
    let current = page
    browser.confluenceResponse = (url, init) => {
      if (init?.method === 'PUT') {
        expect(new URL(url).pathname).toBe(pages + '/42/title')
        expect(init.body).toBe(JSON.stringify({ status: 'current', title: renamed.title }))
        current = renamed
      } else if (++count === 2 && changedBeforeWrite) current = { ...page, version: { number: 3 } }
      return Response.json(current)
    }
    browser.ai.script.push({ toolCalls: [call('rename_page', { title: renamed.title })] }, { reply: 'Rename checked.' })
    await ask(user, 'Rename this page to "Renamed fixture"')
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(changedBeforeWrite ? 0 : 1)
    if (changedBeforeWrite) expect(screen.queryAllByText(/changed after the preview/).length).toBeGreaterThan(0)
    else expect(results(browser)).toContain('"version":3,"changed":true,"contentPreserved":true')
  },
)

it.each(['add', 'remove'])('[UC-CONFLUCO-CONFLUENCE-006-S02] verifies the Cloud label change %s', async (action) => {
  const { browser, user } = await workspace()
  const adding = action === 'add'
  const label = { prefix: 'global', name: 'sample-label' }
  let present = !adding
  browser.confluenceResponse = (url, init) => {
    const target = new URL(url)
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      expect(target.pathname).toBe(labelPath)
      expect(init.method).toBe(adding ? 'POST' : 'DELETE')
      if (adding) expect(init.body).toBe(JSON.stringify([label]))
      else expect(target.searchParams.get('name')).toBe(label.name)
      present = adding
      return adding ? Response.json([label]) : new Response(null, { status: 204 })
    }
    if (target.pathname === pages + '/42/labels') {
      expect(target.searchParams.get('prefix')).toBe('global')
      return Response.json({ results: present ? [label] : [] })
    }
    expect(target.pathname).toBe(pages + '/42')
    return Response.json(page)
  }
  browser.ai.script.push(
    { toolCalls: [call('change_page_label', { label: label.name, action })] },
    { reply: 'Label checked.' },
  )
  await ask(user, adding ? 'Add label sample-label to this page' : 'Remove label sample-label from this page')
  expect(await screen.findByText('Label checked.')).toBeVisible()
  expect(writes(browser)).toHaveLength(1)
  expect(results(browser)).toContain(`"present":${adding},"changed":true`)
})

it.each(['footer', 'reply', 'different page'])(
  '[UC-CONFLUCO-CONFLUENCE-010-S02] [UC-CONFLUCO-CONFLUENCE-010-S03] checks the Cloud discussion target %s',
  async (target) => {
    const { browser, user } = await workspace()
    const reply = target !== 'footer'
    const parent = {
      id: '71',
      status: 'current',
      pageId: target === 'different page' ? '43' : page.id,
      body: { storage: storage('<p>Parent comment</p>') },
    }
    const posted = {
      id: '72',
      pageId: page.id,
      status: 'current',
      parentCommentId: reply ? parent.id : null,
      body: { storage: storage('<p>QA &amp; &lt;note&gt;</p>') },
    }
    browser.confluenceResponse = (url, init) => {
      const pathname = new URL(url).pathname
      if (init?.method === 'POST') {
        expect(pathname).toBe(comments)
        expect(screen.getByText(/Comment: "QA & <note>"/)).toBeVisible()
        expect(init.body).toBe(
          JSON.stringify({
            ...(reply ? { parentCommentId: parent.id } : { pageId: page.id }),
            body: posted.body.storage,
          }),
        )
        return Response.json(posted, { status: 201 })
      }
      if (pathname === comments + '/71') return Response.json(parent)
      if (pathname === comments + '/72') return Response.json(posted)
      expect(pathname).toBe(pages + '/42')
      return Response.json(page)
    }
    browser.ai.script.push({ toolCalls: [call('add_page_comment')] }, { reply: 'Comment checked.' })
    await ask(
      user,
      reply ? 'Reply to comment 71 with "QA & <note>" on this page' : 'Add comment "QA & <note>" on this page',
    )
    await screen.findByRole('button', { name: 'Send' })
    expect(writes(browser)).toHaveLength(target === 'different page' ? 0 : 1)
    if (target === 'different page')
      expect(screen.queryAllByText(/comment on the intended page/).length).toBeGreaterThan(0)
    else expect(results(browser)).toContain('focusedCommentId=72#comment-72')
  },
)
