// That Confluco wires in what every Cofun extension shares: the tools of @cofun/tools, offered to the
// model and run with Confluco's name, and the "Ask Confluco" menu item that hands a selection to the
// side panel, the rules a reply is shown by (@cofun/reply), and how a tool call's card is answered
// (@cofun/agent's ToolPrompts, and @cofun/tools's askToRead). How they behave is verified once, in
// Webco (extensions/webco/test/).
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { DATA_LINE } from '@cofun/tools'
import { FakeTab, webPage } from './tab'
import { closeBrowser, FakeBrowser } from './browser'

afterEach(closeBrowser)

const ARTICLE = 'https://news.example.com/2026/rivers'
const PAGE = 'https://tea.example/oolong'

it('[@no-uc:wiring] the shared tools are offered and run, and "Ask Confluco" hands a selection to the panel, a reply is shown by the shared rules, its HTML as text, and a site card is answered by them', async () => {
  const tab = new FakeTab(ARTICLE)
  tab.title = 'Rivers | News'
  tab.dom = webPage({ title: 'Rivers | News', main: '<p>Rivers are rising.</p>', url: ARTICLE })
  tab.allowed.add('https://news.example.com/*')
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  browser.env.AI_GATEWAY_ID = 'gw-test'
  await browser.startServiceWorker()
  const user = userEvent.setup()

  expect(tab.menuItems.get('ask-confluco')?.title).toBe('Ask Confluco about “%s”')
  tab.pickMenuItem('ask-confluco', 'Rivers are rising.')
  await browser.openPanel()
  expect(await screen.findByText('news.example.com: “Rivers are rising.”')).toBeVisible()

  browser.web.serve(PAGE, '<main><p>Oolong comes from Fujian.</p></main>')
  browser.ai.found.set('oolong', [{ url: PAGE, title: 'Oolong', description: 'Oolong comes from Fujian.' }])
  const call = (name: string, args: object) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })
  browser.ai.script.push(
    call('get_current_tab', {}),
    call('read_current_tab', {}),
    call('read_web_page', { url: PAGE }),
    call('search_web', { query: 'oolong' }),
    {
      reply:
        'Done reading. <b onclick="alert(1)">bold</b> ![Chart](https://img.example.com/c.png) [run](javascript:alert(1))',
    },
  )
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'What is this about?')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(/Done reading/)).toBeVisible()
  await screen.findByRole('button', { name: 'Send' })
  // HTML is shown as text: the view gives its renderer no HTML plugin.
  expect(screen.getByText(/Done reading/)).toHaveTextContent('<b onclick="alert(1)">bold</b>')
  expect(screen.getByText(/Done reading/).querySelector('b')).toBeNull()
  expect(document.querySelector('[src*="img.example.com"]')).toBeNull()
  expect(screen.getByRole('link', { name: 'Chart' })).toHaveAttribute('href', 'https://img.example.com/c.png')
  expect(screen.queryByRole('link', { name: 'run' })).toBeNull()

  const offered = (browser.ai.calls[0].inputs.tools as { function: { name: string } }[]).map((t) => t.function.name)
  expect(offered).toEqual(
    expect.arrayContaining([
      'get_current_tab',
      'read_current_tab',
      'read_tab',
      'read_web_page',
      'render_web_page',
      'search_web',
      'read_result',
      'search_result',
    ]),
  )
  const sent = browser.sentToModel()
  // The selection went with the question, and the shared tools the model called ran and gave it their results.
  expect(sent.find((m) => m.role === 'user')!.content).toContain('Rivers are rising.')
  const results = sent.filter((m) => m.role === 'tool').map((m) => m.content)
  expect(results).toHaveLength(4)
  for (const result of results) expect(result?.startsWith(DATA_LINE + '\n')).toBe(true)

  // A site the user has not allowed: the card's answer goes through the shared prompts, and when
  // Chrome can't show its prompt, the model gets the shared answer.
  tab.switchTab('https://other.example/page', 'Other')
  const failed = Promise.reject(new Error('Synthetic Chrome prompt failure'))
  failed.catch(() => {})
  tab.promptOpen = failed
  browser.ai.script.push(call('read_current_tab', {}), { reply: 'Chrome could not ask.' })
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'And this one?')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  const card = await screen.findByRole('group', { name: 'Allow Confluco to read other.example?' })
  await user.click(within(card).getByRole('button', { name: 'Allow' }))
  expect(await screen.findByText('Chrome could not ask.')).toBeVisible()
  expect(tab.accessRequests).toEqual([['https://other.example/*']])
  expect(
    browser
      .sentToModel()
      .filter((m) => m.role === 'tool')
      .at(-1)?.content,
  ).toMatch(/^Chrome could not request access to the site, so nothing was read\./)
})
