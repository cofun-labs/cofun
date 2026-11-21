// That Notico wires in what every Cofun extension shares: the tools of @cofun/tools, offered to the
// model and run with Notico's name, and the "Ask Notico" menu item that hands a selection to the side
// panel. How they behave is verified once, in Webco (extensions/webco/test/).
import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { DATA_LINE } from '@cofun/tools'
import { FakeNotionTab, webPage } from './notion-tab'
import { closeBrowser, FakeBrowser } from './browser'

afterEach(closeBrowser)

const ARTICLE = 'https://news.example.com/2026/rivers'
const PAGE = 'https://tea.example/oolong'

it('[@no-uc:wiring] the shared tools are offered and run, and "Ask Notico" hands a selection to the panel', async () => {
  const tab = new FakeNotionTab(ARTICLE)
  tab.title = 'Rivers | News'
  tab.dom = webPage({ title: 'Rivers | News', main: '<p>Rivers are rising.</p>', url: ARTICLE })
  tab.allowed.add('https://news.example.com/*')
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  browser.env.AI_GATEWAY_ID = 'gw-test'
  await browser.startServiceWorker()
  const user = userEvent.setup()

  expect(tab.menuItems.get('ask-notico')?.title).toBe('Ask Notico about “%s”')
  tab.pickMenuItem('ask-notico', 'Rivers are rising.')
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
    { reply: 'Done reading.' },
  )
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'What is this about?')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('Done reading.')).toBeVisible()

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
  // The selection went with the question, and every shared tool ran and gave the model its result.
  expect(sent.find((m) => m.role === 'user')!.content).toContain('Rivers are rising.')
  const results = sent.filter((m) => m.role === 'tool').map((m) => m.content)
  expect(results).toHaveLength(4)
  for (const result of results) expect(result.startsWith(DATA_LINE + '\n')).toBe(true)
})
