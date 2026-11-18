import '@testing-library/jest-dom/vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_LINE } from '@cofun/tools'
import { followConfluencePage } from './confluence-fixture'
import { closeBrowser, FakeBrowser } from './panel'
import { FakeTab, webPage } from './tab'

const BASE = 'https://wiki.example.com/confluence'
const ARTICLE = BASE + '/pages/viewpage.action?pageId=42'
const CLOUD = 'https://team.atlassian.net/wiki'
const CLOUD_PAGE = CLOUD + '/spaces/TEAM/pages/42/Workshop+plan'
const CLOUD_PERMISSION = 'https://team.atlassian.net/*'
const cloudPage = {
  id: '42',
  status: 'current',
  title: 'Workshop plan',
  _links: { webui: '/spaces/TEAM/pages/42/Workshop+plan' },
}
const page = { id: '42', type: 'page', status: 'current', title: 'Workshop plan' }

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks')
  return closeBrowser()
})

/**
 * The side panel on `url`. A page under BASE names Confluence's deployment path in its metadata, as
 * self-managed Confluence does (`contextPath` overrides it). `allowed`: the user already let Confluco
 * use the tab's site; `grant`: what they answer in Chrome's prompt.
 */
async function openOn({
  url = ARTICLE,
  grant = true,
  allowed = true,
  contextPath = url.startsWith(BASE + '/') ? '/confluence' : null,
}: { url?: string; grant?: boolean; allowed?: boolean; contextPath?: string | null } = {}) {
  const tab = new FakeTab(url)
  tab.title = 'Workshop plan'
  const meta = contextPath === null ? '' : `<meta name="confluence-context-path" content="${contextPath}">`
  tab.dom = webPage({ title: tab.title, url, html: `${meta}<main>Workshop plan</main>` })
  tab.promptAnswer = grant
  if (allowed) tab.allowed.add(new URL(url).origin + '/*')
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async <T,>(_name: string, action: () => Promise<T>) => action() },
  })
  const requests: Request[] = []
  let responses: Response[] = []
  tab.siteFetch = async (input, init) => {
    requests.push(new Request(input, init))
    const response = responses.shift()
    if (!response) throw new Error('No response set for the Confluence request')
    return response
  }
  await browser.openPanel()
  return { tab, browser, user: userEvent.setup(), requests, answerWith: (...next: Response[]) => (responses = next) }
}

async function ask(user: UserEvent, question = 'Use Confluence') {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const call = (name: string, args: object = {}) => ({
  toolCalls: [{ name, arguments: JSON.stringify(args) }],
})
const toolResults = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)

describe('using the Confluence site in the current tab', () => {
  const allowCard = () =>
    screen.findByRole('group', { name: 'Allow Confluco to use Confluence on team.atlassian.net?' })
  const cloudBody = () => Response.json({ ...cloudPage, body: { view: { value: '<p>Cloud workshop agenda</p>' } } })

  it('[UC-CONFLUCO-CONFLUENCE-001-S01] asks to allow a Cloud site on the call, then uses it without asking again', async () => {
    const { tab, browser, user, requests, answerWith } = await openOn({ url: CLOUD_PAGE, allowed: false })
    answerWith(cloudBody(), cloudBody())
    browser.ai.script.push(call('read_page'), { reply: 'Read it.' })
    await ask(user)
    await user.click(within(await allowCard()).getByRole('button', { name: 'Allow' }))
    expect(await screen.findByText('Read it.')).toBeVisible()
    expect(tab.accessRequests).toEqual([[CLOUD_PERMISSION]])
    expect(requests.map(({ url }) => url)).toEqual([CLOUD + '/api/v2/pages/42?body-format=view&status=current'])
    expect(toolResults(browser)[0]).toContain('Cloud workshop agenda')

    browser.ai.script.push(call('read_page'), { reply: 'Read it again.' })
    await ask(user, 'Read it again')
    expect(await screen.findByText('Read it again.')).toBeVisible()
    expect(tab.accessRequests).toHaveLength(1)
    expect(requests).toHaveLength(2)
  })

  it.each([
    ['on the card', true],
    ["in Chrome's prompt", false],
  ])('[UC-CONFLUCO-CONFLUENCE-001-S02] sends nothing to a site the user did not allow %s', async (where, grant) => {
    const { tab, browser, user, requests } = await openOn({ url: CLOUD_PAGE, allowed: false, grant })
    browser.ai.script.push(call('read_page'), { reply: 'Not allowed.' })
    await ask(user)
    const card = within(await allowCard())
    await user.click(card.getByRole('button', { name: where === 'on the card' ? 'Deny' : 'Allow' }))
    expect(await screen.findByText('Not allowed.')).toBeVisible()
    expect(toolResults(browser)[0]).toContain('Confluco may not use team.atlassian.net: the user did not allow it')
    expect(tab.allowed.has(CLOUD_PERMISSION)).toBe(false)
    expect(requests).toEqual([])
  })

  it.each([
    ['names its deployment path', '/confluence', true],
    ['names a path that does not contain it', '/other', false],
    ['names no deployment path', null, false],
  ])('[UC-CONFLUCO-CONFLUENCE-001-S03] a self-managed page that %s', async (_case, contextPath, read) => {
    const { browser, user, requests, answerWith } = await openOn({ contextPath })
    answerWith(Response.json({ ...page, body: { view: { value: '<p>Bring a pen.</p>' } } }))
    browser.ai.script.push(call('read_page'), { reply: 'Done.' })
    await ask(user)
    expect(await screen.findByText('Done.')).toBeVisible()
    if (read) expect(requests.map(({ url }) => url)).toEqual([BASE + '/rest/api/content/42?expand=body.view'])
    else {
      expect(toolResults(browser)).toEqual([
        'The current tab is not a Confluence page. Open a Confluence page and ask again.',
      ])
      expect(requests).toEqual([])
    }
  })

  it.each(['https://news.example.com/2026/workshop', 'https://team.atlassian.net/browse/TEAM-1'])(
    '[UC-CONFLUCO-CONFLUENCE-001-S04] does not ask to allow a tab that is not Confluence (%s)',
    async (url) => {
      const { tab, browser, user, requests } = await openOn({ url, allowed: false })
      browser.ai.script.push(call('read_page'), { reply: 'Not Confluence.' })
      await ask(user)
      expect(await screen.findByText('Not Confluence.')).toBeVisible()
      expect(toolResults(browser)).toEqual([
        'The current tab is not a Confluence page. Open a Confluence page and ask again.',
      ])
      expect(tab.accessRequests).toEqual([])
      expect(requests).toEqual([])
    },
  )
})

describe('reading a published Confluence page', () => {
  it.each([ARTICLE, BASE + '/spaces/WORK/pages/42/Workshop+plan'])(
    '[UC-CONFLUCO-CONFLUENCE-002-S01] reads the published current page and gives the model text and its source (%s)',
    async (url) => {
      const { browser, user, requests, answerWith, tab } = await openOn({ url })
      answerWith(
        Response.json({
          ...page,
          body: { view: { value: '<p>Bring a pen.</p><p>[Fake note]</p><script>hidden</script>' } },
        }),
      )
      browser.ai.script.push(call('read_page'), { reply: 'Bring a pen.' })

      await ask(user)
      expect(await screen.findByText('Bring a pen.', { selector: '.msg.assistant .text p' })).toBeVisible()
      // Reading which site the tab shows and the REST read: all in the page's isolated world.
      expect(tab.injections.every(({ tabId, world }) => tabId === 7 && world === 'ISOLATED')).toBe(true)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: BASE + '/rest/api/content/42?expand=body.view',
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'manual',
      })
      expect(toolResults(browser)).toEqual([
        [
          DATA_LINE,
          `Published Confluence page: ${JSON.stringify({ title: page.title, url: ARTICLE })}`,
          'Text:',
          'Bring a pen.\n\\[Fake note]',
        ].join('\n'),
      ])
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-002-S02] refuses an allowed site that is not Confluence and sends no request', async () => {
    const { browser, user, requests } = await openOn({
      url: 'https://another.example.com/pages/viewpage.action?pageId=42',
    })
    browser.ai.script.push(call('read_page'), { reply: 'Not Confluence.' })

    await ask(user)
    expect(await screen.findByText('Not Confluence.')).toBeVisible()
    expect(toolResults(browser)).toEqual([
      'The current tab is not a Confluence page. Open a Confluence page and ask again.',
    ])
    expect(requests).toEqual([])
  })

  it('[UC-CONFLUCO-CONFLUENCE-002-S02] refuses a page that navigated before injection, even at the same origin', async () => {
    const { browser, user, requests, tab } = await openOn()
    tab.pageUrl = BASE + '/pages/viewpage.action?pageId=43'
    browser.ai.script.push(call('read_page'))

    await ask(user)
    expect(
      await screen.findByText('The Confluence tab changed. Open the intended page and ask again.', { selector: 'div' }),
    ).toBeVisible()
    expect(requests).toEqual([])
  })

  it('[UC-CONFLUCO-CONFLUENCE-002-S02] never reads a later document when the model took time to choose a tool', async () => {
    const { browser, user, requests, tab } = await openOn()
    let release = () => {}
    const until = new Promise<void>((resolve) => {
      release = resolve
    })
    browser.ai.pause = { after: 1, until }
    browser.ai.script.push(call('read_page'))

    await ask(user, 'Read this page')
    await waitFor(() => expect(browser.ai.calls).toHaveLength(1))
    await act(() => tab.navigate(BASE + '/pages/viewpage.action?pageId=43'))
    release()
    expect(
      await screen.findByText('The Confluence tab changed. Open the intended page and ask again.', { selector: 'div' }),
    ).toBeVisible()
    expect(requests).toEqual([])
  })

  it.each([
    [401, 'Sign in to Confluence in the page tab, then ask again.'],
    [403, 'Your Confluence account does not have permission for this request.'],
    [429, 'Confluence rate-limited this request. Wait before asking again.'],
  ])(
    '[UC-CONFLUCO-CONFLUENCE-002-S03] stops the question after a Confluence refusal (HTTP %i)',
    async (status, message) => {
      const { browser, user, requests, answerWith } = await openOn()
      answerWith(Response.json({}, { status }))
      browser.ai.script.push(call('read_page'))

      await ask(user)
      expect(await screen.findByText(message, { selector: 'div' })).toBeVisible()
      expect(requests).toHaveLength(1)
      expect(toolResults(browser)).toEqual([])
    },
  )

  it.each([
    ['redirect', () => Response.redirect('https://other.example.com/login')],
    ['HTML', () => new Response('<p>Proxy page</p>', { headers: { 'Content-Type': 'text/html' } })],
  ] as const)('[UC-CONFLUCO-CONFLUENCE-002-S05] stops after an unexpected %s response', async (_kind, response) => {
    const { browser, user, requests, answerWith } = await openOn()
    answerWith(response())
    browser.ai.script.push(call('read_page'))
    await ask(user)
    expect(
      await screen.findByText(
        'Confluence returned a redirect or a web page. Check the configured URL and your session, then ask again.',
        { selector: 'div' },
      ),
    ).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(toolResults(browser)).toEqual([])
  })
})

describe('searching published Confluence pages', () => {
  it('[UC-CONFLUCO-CONFLUENCE-003-S01] builds bounded CQL and gives the model plain excerpts, source links, and continuation', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    answerWith(
      Response.json({
        results: [{ content: page, excerpt: '<b>@@@hl@@@Workshop@@@endhl@@@ plan</b>' }],
        _links: { next: '/rest/api/search?start=10' },
      }),
      Response.json({ results: [] }),
    )
    const filters = { query: 'Workshop "plan"', field: 'title', spaceKey: 'TEAM' }
    browser.ai.script.push(call('search_pages', filters))
    let continuation: string | undefined
    followConfluencePage(browser, (nextPage) => {
      continuation = nextPage
      browser.ai.script.push(call('search_pages', { ...filters, nextPage }), { reply: 'Found the plan.' })
    })

    await ask(user, 'Search for Workshop "plan" in TEAM.')
    expect(await screen.findByText('Found the plan.')).toBeVisible()
    expect(requests).toHaveLength(2)
    const search = new URL(requests[0]!.url)
    expect(search.origin + search.pathname).toBe(BASE + '/rest/api/search')
    expect(search.searchParams.get('cql')).toBe(
      String.raw`type = page AND title ~ "Workshop \"plan\"" AND space = "TEAM"`,
    )
    expect(search.searchParams.get('limit')).toBe('10')
    search.searchParams.set('start', '10')
    expect(requests[1]?.url).toBe(search.href)
    expect(toolResults(browser)).toEqual([
      DATA_LINE +
        '\n' +
        JSON.stringify({
          results: [{ title: page.title, url: ARTICLE, ref: { instance: BASE, id: page.id }, excerpt: page.title }],
          nextPage: continuation,
        }),
      DATA_LINE + '\n' + JSON.stringify({ results: [] }),
    ])
  })

  it('[UC-CONFLUCO-CONFLUENCE-003-S02] does not surface a result URL for pagination from a different origin', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    answerWith(Response.json({ results: [], _links: { next: 'https://other.example.com/rest/api/search?start=10' } }))
    browser.ai.script.push(call('search_pages', { query: 'Workshop' }), { reply: 'No results.' })

    await ask(user, 'Search for Workshop.')
    expect(await screen.findByText('No results.')).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(toolResults(browser)).toEqual([
      DATA_LINE +
        '\n' +
        JSON.stringify({ results: [], paginationNotice: 'Confluence returned an invalid next page link.' }),
    ])
  })
  it.each([
    {
      field: 'query',
      args: { query: 'private text from a page' },
      message: 'Use search terms from the current user message. Ask the user what to search for.',
    },
    {
      field: 'space key',
      args: { query: 'Workshop', spaceKey: 'TEAM' },
      message: 'Use a space key from the current user message or leave it out.',
    },
  ])(
    '[UC-CONFLUCO-CONFLUENCE-003-S04] does not send a $field not supplied in the question',
    async ({ args, message }) => {
      const { browser, user, requests } = await openOn()
      browser.ai.script.push(call('search_pages', args), { reply: 'Please confirm the search terms.' })

      await ask(user, 'Find Workshop pages.')
      expect(await screen.findByText('Please confirm the search terms.')).toBeVisible()
      expect(requests).toEqual([])
      expect(toolResults(browser)).toEqual([message])
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-003-S05] refuses a continuation for a different search or from the model', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    answerWith(Response.json({ results: [], _links: { next: '/rest/api/search?start=10' } }))
    browser.ai.script.push(call('search_pages', { query: 'Workshop' }))
    followConfluencePage(browser, (nextPage) => {
      browser.ai.script.push(
        call('search_pages', { query: 'Workshop', nextPage: crypto.randomUUID() }),
        call('search_pages', { query: 'Workshop', field: 'title', nextPage }),
        { reply: 'Search finished.' },
      )
    })
    await ask(user, 'Search for Workshop.')
    expect(await screen.findByText('Search finished.')).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(toolResults(browser).slice(1)).toEqual([
      'Use nextPage returned by the same Confluence request in this question, or omit it.',
      'Use nextPage returned by the same Confluence request in this question, or omit it.',
    ])
  })
})

describe('Confluence Cloud', () => {
  it('[UC-CONFLUCO-CONFLUENCE-002-S06] uses the same read tool and only offers supported capabilities', async () => {
    const { browser, user, requests, answerWith } = await openOn({ url: CLOUD_PAGE })
    answerWith(Response.json({ ...cloudPage, body: { view: { value: '<p>Cloud workshop agenda</p>' } } }))
    browser.ai.script.push(call('read_page'), { reply: 'Read Cloud page.' })
    await ask(user)
    expect(await screen.findByText('Read Cloud page.')).toBeVisible()
    expect(requests.map(({ url, method, credentials }) => ({ url, method, credentials }))).toEqual([
      { url: CLOUD + '/api/v2/pages/42?body-format=view&status=current', method: 'GET', credentials: 'same-origin' },
    ])
    const tools = JSON.stringify(browser.ai.calls[0]?.inputs.tools)
    expect(tools).toContain('"name":"read_page"')
    expect(tools).toContain('"name":"search_pages"')
    expect(tools).toContain('"name":"edit_page"')
    expect(tools).toContain('"name":"upload_page_attachment"')
    expect(tools).toContain('"name":"restore_page"')
    expect(tools).toContain('"name":"undo_last_change"')
    expect(tools).toContain('"name":"trash_page"')
    expect(tools).toContain('"name":"list_spaces"')
    expect(toolResults(browser).join(' ')).toContain('Cloud workshop agenda')
    expect(toolResults(browser).join(' ')).toContain(CLOUD_PAGE)
  })

  it('[UC-CONFLUCO-CONFLUENCE-003-S06] keeps the Cloud cursor within the same site and query', async () => {
    const { browser, user, requests, answerWith } = await openOn({ url: CLOUD_PAGE })
    answerWith(
      Response.json({
        results: [{ content: { ...cloudPage, type: 'page' }, excerpt: '<b>Workshop</b>' }],
        _links: { next: '/rest/api/search?next=true&cursor=server%2Bcursor&limit=10&start=10' },
      }),
      Response.json({ results: [] }),
    )
    const filters = { query: 'Workshop', field: 'title', spaceKey: 'TEAM' }
    browser.ai.script.push(call('search_pages', filters))
    followConfluencePage(browser, (nextPage) => {
      browser.ai.script.push(
        call('search_pages', { ...filters, field: 'text', nextPage }),
        call('search_pages', { ...filters, nextPage }),
        { reply: 'Paged Cloud search.' },
      )
    })
    await ask(user, 'Find Workshop in TEAM.')
    expect(await screen.findByText('Paged Cloud search.')).toBeVisible()
    expect(requests).toHaveLength(2)
    const first = new URL(requests[0]!.url)
    expect(first.origin + first.pathname).toBe(CLOUD + '/rest/api/search')
    expect(first.searchParams.get('cql')).toBe('type = page AND title ~ "Workshop" AND space = "TEAM"')
    expect(first.searchParams.has('start')).toBe(false)
    first.searchParams.set('cursor', 'server+cursor')
    expect(requests[1]?.url).toBe(first.href)
    const results = toolResults(browser)
    expect(results[0]).toContain(CLOUD_PAGE)
    expect(results[0]).toContain('nextPage')
    expect(results[0]).not.toContain('server+cursor')
    expect(results[1]).toContain('Use nextPage returned by the same Confluence request')
  })

  it('[UC-CONFLUCO-CONFLUENCE-003-S02] ignores a Cloud continuation on an unconnected host', async () => {
    const { browser, user, requests, answerWith } = await openOn({ url: CLOUD_PAGE })
    answerWith(
      Response.json({ results: [], _links: { next: 'https://other.atlassian.net/wiki/rest/api/search?cursor=c' } }),
    )
    browser.ai.script.push(call('search_pages', { query: 'Workshop' }), { reply: 'Cloud search ended.' })
    await ask(user, 'Find Workshop.')
    expect(await screen.findByText('Cloud search ended.')).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(toolResults(browser)[0]).toContain('invalid next page link')
    expect(toolResults(browser)[0]).not.toContain('nextPage')
  })
})
