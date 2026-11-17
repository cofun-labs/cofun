import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { base, closeWorkspace, openWorkspace, type WorkspaceBrowser } from './confluence-fixture'

afterEach(closeWorkspace)

const pageUrl = base + '/pages/viewpage.action?pageId=42'
const api = '/kb/rest/api/content'
const page = { id: '42', type: 'page', status: 'current', title: 'Discussion fixture' }
const body = (value: string) => ({ storage: { value, representation: 'storage' } })
const root = {
  id: '71',
  type: 'comment',
  status: 'current',
  ancestors: [],
  container: { id: page.id, type: 'page' },
  body: body('<p>Original discussion</p>'),
  extensions: { location: 'footer' },
}
const reply = {
  ...root,
  id: '72',
  ancestors: [{ id: root.id, type: 'comment' }],
  body: body('<p>Reply text</p>'),
}
const add = { name: 'add_page_comment', arguments: '{}' }
const list = { name: 'list_page_comments', arguments: '{}' }

async function openPanel() {
  const { browser, user } = await openWorkspace({ url: pageUrl, title: page.title })
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

describe('published page discussions', () => {
  it('[UC-CONFLUCO-CONFLUENCE-010-S01] returns bounded comments, sources, parent IDs and continuation', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (url) => {
      const target = new URL(url)
      if (target.pathname === api + '/42') return Response.json(page)
      expect(target.pathname).toBe(api + '/42/child/comment')
      expect(target.searchParams.get('limit')).toBe('10')
      expect(target.searchParams.get('depth')).toBe('all')
      if (target.searchParams.get('start') === '2')
        return Response.json({ results: [{ ...root, id: '73', body: body('<p>Older thread marker</p>') }] })
      return Response.json({
        results: [
          root,
          {
            ...reply,
            ancestors: [...reply.ancestors, { id: '70', type: 'comment' }],
            extensions: { location: 'inline' },
          },
        ],
        _links: { next: '/rest/api/content/42/child/comment?start=2&limit=10' },
      })
    }
    browser.ai.script.push(
      { toolCalls: [list] },
      { toolCalls: [{ ...list, arguments: '{"start":2}' }] },
      { reply: 'Discussion read.' },
    )
    await ask(user, 'Show the comments.')
    expect(await screen.findByText('Discussion read.')).toBeVisible()
    expect(results(browser)).toContain(pageUrl + '&focusedCommentId=72#comment-72')
    expect(results(browser)).toContain('"parentId":"71","location":"inline"')
    expect(results(browser)).toContain('"location":"footer"')
    expect(results(browser)).toContain('"nextStart":2')
    expect(results(browser)).toContain('Older thread marker')
    expect(writes(browser)).toEqual([])
  })

  it.each([false, true])(
    '[UC-CONFLUCO-CONFLUENCE-010-S02] previews and verifies the intended thread (reply %s)',
    async (isReply) => {
      const { browser, user } = await openPanel()
      const text = 'QA & <note>\n\nNext line'
      const submittedBody = body('<p>QA &amp; &lt;note&gt;<br /><br />Next line</p>')
      const posted = {
        ...reply,
        ancestors: isReply ? reply.ancestors : [],
        body: body('<p>QA &amp; &lt;note&gt;<br/><br/>Next line</p>'),
      }
      browser.confluenceResponse = (url, init) => {
        const target = new URL(url)
        if (init?.method === 'POST') {
          expect(target.pathname).toBe(api)
          expect(
            screen.getByText(
              isReply ? /Reply to comment 71 on "Discussion fixture"/ : /Add a footer comment to "Discussion fixture"/,
            ),
          ).toHaveTextContent('Comment: ' + JSON.stringify(text))
          expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
          expect(init.body).toBe(
            JSON.stringify({
              type: 'comment',
              container: { id: page.id, type: 'page' },
              ...(isReply && { ancestors: reply.ancestors }),
              body: submittedBody,
            }),
          )
          return Response.json(posted)
        }
        if (target.pathname.endsWith('/71')) return Response.json(root)
        if (target.pathname.endsWith('/72')) return Response.json(posted)
        return Response.json(page)
      }
      browser.ai.script.push({ toolCalls: [add] }, { reply: 'Posted and verified.' })
      await user.click(screen.getByRole('textbox', { name: 'Message' }))
      await user.paste(
        isReply ? `Reply to comment 71 with "${text}" on this page` : `Add comment "${text}" on this page`,
      )
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await answered()
      expect(results(browser)).toContain(pageUrl + '&focusedCommentId=72#comment-72')
      expect(writes(browser)).toHaveLength(1)
      expect(browser.workspaceRequests.at(-1)?.url).toContain('/72?expand=')
    },
  )

  it.each([
    ['Summarize the page', root, /Ask the user to say Add comment/],
    [
      'Reply to comment 71 with "QA" on this page',
      { ...root, extensions: { location: 'inline' } },
      /verified footer comment/,
    ],
    [
      'Reply to comment 71 with "QA" on this page',
      { ...root, container: { id: '43', type: 'page' } },
      /comment on the intended page/,
    ],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-010-S03] rejects an unapproved request or wrong reply target (%s)',
    async (message, parent, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url) => Response.json(new URL(url).pathname.endsWith('/71') ? parent : page)
      browser.ai.script.push({ toolCalls: [add] })
      await ask(user, message)
      await answered()
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toEqual([])
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-010-S03] reports a server permission denial', async () => {
    const { browser, user } = await openPanel()
    browser.confluenceResponse = (_url, init) =>
      init?.method === 'POST' ? new Response(null, { status: 403 }) : Response.json(page)
    browser.ai.script.push({ toolCalls: [add, add] })
    await ask(user, 'Add comment "QA" on this page')
    await answered()
    expect(screen.getAllByText(/does not have permission/).length).toBeGreaterThan(0)
    expect(writes(browser)).toHaveLength(1)
  })

  it.each([
    [503, '', /change may have been applied/],
    [200, '<p>QA note<img src="test.png" /></p>', /comment may have been posted/],
    [200, '<p>QA note</p>', /comment may have been posted/],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-010-S04] stops without another post when the result is uncertain (%s, %s)',
    async (status, storage, reason) => {
      const { browser, user } = await openPanel()
      browser.confluenceResponse = (url, init) => {
        if (init?.method === 'POST') {
          expect(init.body).toContain('<p>QA<br /><br />note</p>')
          return status === 200 ? Response.json(root) : new Response(null, { status })
        }
        if (new URL(url).pathname.endsWith('/71')) return Response.json({ ...root, body: body(storage) })
        return Response.json(page)
      }
      browser.ai.script.push({ toolCalls: [add, add] })
      await user.click(screen.getByRole('textbox', { name: 'Message' }))
      await user.paste('Add comment "QA\n\nnote" on this page')
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await answered()
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
      expect(writes(browser)).toHaveLength(1)
    },
  )
})

it('[UC-CONFLUCO-CONFLUENCE-010-S04] reports a rate limit verifying a posted comment and stops', async () => {
  const { browser, user } = await openPanel()
  let written = false
  let verificationReads = 0
  browser.confluenceResponse = (_url, init) => {
    if (init?.method === 'POST') {
      written = true
      return Response.json(root)
    }
    if (written) {
      verificationReads++
      return new Response(null, { status: 429 })
    }
    return Response.json(page)
  }
  browser.ai.script.push({ toolCalls: [add, add] })
  await ask(user, 'Add comment "QA note" on this page')
  await answered()
  expect(screen.getAllByText(/comment may have been posted.*rate-limited/).length).toBeGreaterThan(0)
  expect(writes(browser)).toHaveLength(1)
  expect(verificationReads).toBe(1)
})
