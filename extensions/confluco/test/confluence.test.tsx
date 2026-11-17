import '@testing-library/jest-dom/vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_LINE } from '../src/tools/shared'
import { followConfluencePage } from './confluence-fixture'
import { closeBrowser, FakeBrowser } from './panel'
import { FakeTab, webPage } from './tab'

const BASE = 'https://wiki.example.com/confluence'
const ARTICLE = BASE + '/pages/viewpage.action?pageId=42'
const SITE = 'https://wiki.example.com:443/*'
const CLOUD = 'https://team.atlassian.net/wiki'
const CLOUD_PAGE = CLOUD + '/spaces/TEAM/pages/42/Workshop+plan'
const CLOUD_PERMISSION = 'https://team.atlassian.net:443/*'
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

async function openOn({ url = ARTICLE, grant = true } = {}) {
  const tab = new FakeTab(url)
  tab.title = 'Workshop plan'
  tab.dom = webPage({ title: tab.title, url, main: 'Workshop plan' })
  tab.promptAnswer = grant
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

const section = () => screen.findByRole('region', { name: 'Confluence connection' })

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  return within(await section())
}

async function connect(user: UserEvent, url = BASE) {
  const settings = await openSettings(user)
  await user.type(await settings.findByRole('textbox', { name: 'Confluence base URL' }), url)
  await user.click(settings.getByRole('button', { name: 'Connect' }))
  return settings
}

async function connected(user: UserEvent, base = BASE) {
  const settings = await connect(user, base)
  expect(await settings.findByText('Connected to ' + base)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Back' }))
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

describe('connecting Confluence', () => {
  it('[UC-CONFLUCO-CONFLUENCE-001-S01] remembers a granted connection and removes it on disconnect', async () => {
    const { tab, browser, user, requests } = await openOn()
    await connected(user)
    expect(tab.accessRequests).toEqual([[SITE]])
    expect(requests).toEqual([])

    await browser.openPanel()
    const settings = await openSettings(user)
    expect(await settings.findByText('Connected to ' + BASE)).toBeVisible()
    await user.click(settings.getByRole('button', { name: 'Disconnect' }))
    expect(await settings.findByRole('textbox', { name: 'Confluence base URL' })).toBeVisible()
    expect(tab.allowed.has(SITE)).toBe(false)
  })

  it('[UC-CONFLUCO-CONFLUENCE-001-S02] does not connect when Chrome access is declined', async () => {
    const { user, tab } = await openOn({ grant: false })
    const settings = await connect(user)
    expect(await settings.findByRole('alert')).toHaveTextContent('Chrome site access was declined')
    expect(tab.allowed.has(SITE)).toBe(false)
  })

  it('[UC-CONFLUCO-CONFLUENCE-001-S03] connects a Cloud origin to its wiki after the user grants Chrome access', async () => {
    const { browser, user, tab, requests } = await openOn({ url: CLOUD_PAGE })
    const settings = await connect(user, 'https://team.atlassian.net')
    expect(await settings.findByText('Connected to ' + CLOUD)).toBeVisible()
    expect(tab.accessRequests).toEqual([[CLOUD_PERMISSION]])
    expect(requests).toEqual([])
    await browser.openPanel()
    const reopened = await openSettings(user)
    expect(await reopened.findByText('Connected to ' + CLOUD)).toBeVisible()
    await user.click(reopened.getByRole('button', { name: 'Disconnect' }))
    expect(await reopened.findByRole('textbox', { name: 'Confluence base URL' })).toBeVisible()
    expect(tab.allowed.has(CLOUD_PERMISSION)).toBe(false)
  })

  it('[UC-CONFLUCO-CONFLUENCE-001-S07] rejects a Cloud page URL before asking for Chrome access', async () => {
    const { user, tab } = await openOn({ url: CLOUD_PAGE })
    const settings = await connect(user, CLOUD_PAGE)
    expect(await settings.findByRole('alert')).toHaveTextContent('Enter a Confluence Cloud site URL')
    expect(tab.accessRequests).toEqual([])
  })

  it('[UC-CONFLUCO-CONFLUENCE-001-S05] keeps access that was granted before connecting', async () => {
    const { user, tab } = await openOn()
    const origin = 'https://wiki.example.com:8443'
    const permission = origin + '/*'
    tab.allowed.add(permission)

    const settings = await connect(user, origin + '/confluence')
    expect(await settings.findByText('Connected to ' + origin + '/confluence')).toBeVisible()
    await user.click(settings.getByRole('button', { name: 'Disconnect' }))
    expect(await settings.findByRole('textbox', { name: 'Confluence base URL' })).toBeVisible()
    expect(tab.allowed.has(permission)).toBe(true)
  })

  it('[UC-CONFLUCO-CONFLUENCE-001-S06] updates open Settings when another window disconnects', async () => {
    const { user, tab } = await openOn()
    const settings = await connect(user)
    expect(await settings.findByText('Connected to ' + BASE)).toBeVisible()

    await act(() => tab.storage.local.remove('confluence-instance:user_alice'))
    expect(await settings.findByRole('textbox', { name: 'Confluence base URL' })).toBeVisible()
  })
})

describe('reading a published Confluence page', () => {
  it.each([ARTICLE, BASE + '/spaces/WORK/pages/42/Workshop+plan'])(
    '[UC-CONFLUCO-CONFLUENCE-002-S01] reads the published current page and gives the model text and its source (%s)',
    async (url) => {
      const { browser, user, requests, answerWith, tab } = await openOn({ url })
      await connected(user)
      answerWith(
        Response.json({
          ...page,
          body: { view: { value: '<p>Bring a pen.</p><p>[Fake note]</p><script>hidden</script>' } },
        }),
      )
      browser.ai.script.push(call('read_page'), { reply: 'Bring a pen.' })

      await ask(user)
      expect(await screen.findByText('Bring a pen.', { selector: '.msg.assistant .text p' })).toBeVisible()
      expect(tab.injections).toEqual([{ tabId: 7, world: 'ISOLATED' }])
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

  it('[UC-CONFLUCO-CONFLUENCE-002-S02] refuses a different site and sends no Confluence request', async () => {
    const { browser, user, requests } = await openOn({
      url: 'https://another.example.com/pages/viewpage.action?pageId=42',
    })
    await connected(user)
    browser.ai.script.push(call('read_page'), { reply: 'Open the connected site.' })

    await ask(user)
    expect(await screen.findByText('Open the connected site.')).toBeVisible()
    expect(toolResults(browser)).toEqual(['Open the connected Confluence site in the current tab.'])
    expect(requests).toEqual([])
  })

  it('[UC-CONFLUCO-CONFLUENCE-002-S02] refuses a page that navigated before injection, even at the same origin', async () => {
    const { browser, user, requests, tab } = await openOn()
    await connected(user)
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
    await connected(user)
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
      await connected(user)
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
    await connected(user)
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
    await connected(user)
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
    await connected(user)
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
      await connected(user)
      browser.ai.script.push(call('search_pages', args), { reply: 'Please confirm the search terms.' })

      await ask(user, 'Find Workshop pages.')
      expect(await screen.findByText('Please confirm the search terms.')).toBeVisible()
      expect(requests).toEqual([])
      expect(toolResults(browser)).toEqual([message])
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-003-S05] refuses a continuation for a different search or from the model', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    await connected(user)
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
    await connected(user, CLOUD)
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
    expect(tools).not.toContain('"name":"edit_page"')
    expect(tools).not.toContain('"name":"upload_page_attachment"')
    expect(tools).not.toContain('"name":"restore_page"')
    expect(tools).not.toContain('"name":"undo_last_change"')
    expect(tools).toContain('"name":"trash_page"')
    expect(tools).toContain('"name":"list_spaces"')
    expect(toolResults(browser).join(' ')).toContain('Cloud workshop agenda')
    expect(toolResults(browser).join(' ')).toContain(CLOUD_PAGE)
  })

  it.each([
    {
      url: CLOUD_PAGE.replace('team.atlassian.net', 'other.atlassian.net'),
      message: 'Open the connected Confluence site',
    },
    { url: CLOUD_PAGE, message: 'Confluco needs Chrome site access', revoke: true },
  ])(
    '[UC-CONFLUCO-CONFLUENCE-002-S02] sends no Cloud request without the intended tab and permission ($url)',
    async ({ url, message, revoke }) => {
      const { browser, user, requests, tab } = await openOn({ url })
      await connected(user, CLOUD)
      if (revoke) tab.allowed.delete(CLOUD_PERMISSION)
      browser.ai.script.push(call('read_page'), { reply: 'Cannot read Cloud.' })
      await ask(user)
      if (revoke) expect(await screen.findByText(new RegExp(message), { selector: 'div' })).toBeVisible()
      else {
        expect(await screen.findByText('Cannot read Cloud.')).toBeVisible()
        expect(toolResults(browser)[0]).toContain(message)
      }
      expect(JSON.stringify(browser.ai.calls[0]?.inputs.tools)).not.toContain('"name":"edit_page"')
      expect(requests).toEqual([])
    },
  )

  it('[UC-CONFLUCO-CONFLUENCE-003-S06] keeps the Cloud cursor within the same site and query', async () => {
    const { browser, user, requests, answerWith } = await openOn({ url: CLOUD_PAGE })
    await connected(user, CLOUD)
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
    await connected(user, CLOUD)
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
