// The current tab on a Notion page, read with the tool for a page on any site (read_current_tab):
// Notico sends the model to its own Notion tools instead. How a page on another site is read is
// verified in Webco (extensions/webco/test/read-current-tab.test.tsx).
import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { FakeNotionTab } from './notion-tab'
import { closeBrowser, FakeBrowser } from './browser'

afterEach(closeBrowser)

it('[UC-NOTICO-PANEL-001-S13] a Notion page in the current tab is not read as a web page: the model is told to read it with read_page', async () => {
  const tab = new FakeNotionTab('https://app.notion.com/p/Notes-2b2b2b2b000040008000000000000020')
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  const user = userEvent.setup()
  browser.ai.script.push(
    { toolCalls: [{ name: 'read_current_tab', arguments: JSON.stringify({}) }] },
    { reply: 'I could not read it.' },
  )

  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Summarize this page')
  await user.click(screen.getByRole('button', { name: 'Send' }))

  expect(await screen.findByText('I could not read it.')).toBeVisible()
  expect(browser.tab.accessRequests).toEqual([])
  expect(browser.tab.injections).toEqual([])
  expect(browser.tab.sent).toEqual([])
  const results = browser
    .sentToModel()
    .filter((m) => m.role === 'tool')
    .map((m) => m.content)
  expect(results).toEqual(['The current tab is a Notion page: read it with read_page instead.'])
})
