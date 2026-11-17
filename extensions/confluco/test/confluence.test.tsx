import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_LINE } from '../src/tools/shared'
import { closeBrowser, FakeBrowser } from './panel'
import { FakeTab, webPage } from './tab'

const BASE = 'https://wiki.example.com/confluence'
const ARTICLE = BASE + '/pages/viewpage.action?pageId=42'
const SITE = 'https://wiki.example.com:443/*'
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

async function connected(user: UserEvent) {
  const settings = await connect(user)
  expect(await settings.findByText('Connected to ' + BASE)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Back' }))
}

async function ask(user: UserEvent) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Use Confluence')
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

describe('connecting a self-managed Confluence site', () => {
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

  it('[UC-CONFLUCO-CONFLUENCE-001-S03] rejects a Cloud URL before requesting Chrome access', async () => {
    const { user, tab } = await openOn()
    const settings = await connect(user, 'https://team.atlassian.net/wiki')
    expect(await settings.findByRole('alert')).toHaveTextContent('Enter a self-managed Confluence base URL')
    expect(tab.accessRequests).toEqual([])
  })
})

describe('reading a published Confluence page', () => {
  it('[UC-CONFLUCO-CONFLUENCE-002-S01] reads the published current page inside its tab and gives the model text and its source', async () => {
    const { browser, user, requests, answerWith, tab } = await openOn()
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
  })

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
})

describe('searching published Confluence pages', () => {
  it('[UC-CONFLUCO-CONFLUENCE-003-S01] builds bounded CQL and gives the model plain excerpts, source links, and the next offset', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    await connected(user)
    answerWith(
      Response.json({
        results: [{ content: page, excerpt: '<b>@@@hl@@@Workshop@@@endhl@@@ plan</b>' }],
        _links: { next: '/rest/api/search?start=10' },
      }),
    )
    browser.ai.script.push(call('search_pages', { query: 'Workshop "plan"', field: 'title', spaceKey: 'TEAM' }), {
      reply: 'Found the plan.',
    })

    await ask(user)
    expect(await screen.findByText('Found the plan.')).toBeVisible()
    expect(requests).toHaveLength(1)
    const search = new URL(requests[0]!.url)
    expect(search.origin + search.pathname).toBe(BASE + '/rest/api/search')
    expect(search.searchParams.get('cql')).toBe(
      String.raw`type = page AND title ~ "Workshop \"plan\"" AND space = "TEAM"`,
    )
    expect(search.searchParams.get('limit')).toBe('10')
    expect(toolResults(browser)).toEqual([
      DATA_LINE +
        '\n' +
        JSON.stringify({ results: [{ title: page.title, url: ARTICLE, excerpt: page.title }], nextStart: 10 }),
    ])
  })

  it('[UC-CONFLUCO-CONFLUENCE-003-S02] does not surface a result URL for pagination from a different origin', async () => {
    const { browser, user, requests, answerWith } = await openOn()
    await connected(user)
    answerWith(Response.json({ results: [], _links: { next: 'https://other.example.com/rest/api/search?start=10' } }))
    browser.ai.script.push(call('search_pages', { query: 'Workshop' }), { reply: 'No results.' })

    await ask(user)
    expect(await screen.findByText('No results.')).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(toolResults(browser)).toEqual([
      DATA_LINE +
        '\n' +
        JSON.stringify({ results: [], paginationNotice: 'Confluence returned an invalid next page link.' }),
    ])
  })
})
