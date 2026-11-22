// Asking something that needs a tool (UC-WEBCO-AGENT-001), as a user meets it in the side panel:
// one example of each rule of the agent loop. The rest of each rule is in @cofun/agent's own
// tests (packages/agent/test/loop.test.ts).
import '@testing-library/jest-dom/vitest'
import { screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './browser'
import { FakeTab } from './tab'

afterEach(closeBrowser)

const ARTICLE = 'https://tea.example/history'
const MISSING = 'https://tea.example/gone'

async function open() {
  const tab = new FakeTab('https://www.example.com/')
  tab.title = 'Example Domain'
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  browser.web.serve(
    ARTICLE,
    '<html><head><title>Tea history</title></head><body><main><p>Tea was first drunk in China.</p></main></body></html>',
  )
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

async function ask(user: UserEvent, question: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** How long a question of many steps may take to show how it ended. */
const LONG = { timeout: 4000 }

const answered = () => screen.findByRole('button', { name: 'Send' })

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })
const currentTab = call('get_current_tab')
const read = (url: string) => call('read_web_page', { url })

describe('asking something that needs a tool', () => {
  it('[UC-WEBCO-AGENT-001-S01] the tool runs in the extension and the answer uses its result', async () => {
    const { browser, user } = await open()
    browser.ai.script.push({ toolCalls: [read(ARTICLE)] }, { reply: 'Tea was first drunk in China.' })
    await ask(user, 'Where was tea first drunk?')
    expect(await screen.findByText('Tea was first drunk in China.')).toBeVisible()
    expect(browser.sentToModel().filter((m) => m.role === 'tool')).toEqual([
      expect.objectContaining({ content: expect.stringContaining('Tea was first drunk in China.') }),
    ])
  })

  it('[UC-WEBCO-AGENT-001-S02] a model that keeps calling tools is stopped at the step limit, and the next question works', async () => {
    const { browser, user } = await open()
    browser.ai.toolCalls = [currentTab]
    await ask(user, 'Which tab am I on?')
    // 20 round trips to the model: give the screen longer to show it.
    expect(await screen.findByText('Stopped after 20 steps. Ask again to continue.', {}, LONG)).toBeVisible()
    await answered()

    browser.ai.toolCalls = undefined
    browser.ai.script.push({ reply: 'You are on Example Domain.' })
    await ask(user, 'And now?')
    expect(await screen.findByText('You are on Example Domain.')).toBeVisible()
  })

  it('[UC-WEBCO-AGENT-001-S03] a model that keeps calling a tool that fails is stopped after 10 failed calls', async () => {
    const { browser, user } = await open()
    browser.ai.toolCalls = [read(MISSING)]
    await ask(user, 'What does the page say?')
    expect(
      await screen.findByText(
        'Stopped: 10 actions in this question failed. Ask again, perhaps in other words.',
        {},
        LONG,
      ),
    ).toBeVisible()
    await answered()
    expect(browser.web.asked).toHaveLength(10)

    browser.ai.toolCalls = undefined
    browser.ai.script.push({ reply: 'I could not read it.' })
    await ask(user, 'Thanks')
    expect(await screen.findByText('I could not read it.')).toBeVisible()
  })

  it('[UC-WEBCO-AGENT-001-S04] Stop keeps the tools used so far, and drops the unfinished reply', async () => {
    const { browser, user } = await open()
    let resume!: () => void
    browser.ai.script.push({ toolCalls: [read(ARTICLE)] }, { reply: 'Tea was first drunk in China.' })
    // The reply after the tool stops partway: the model is still writing.
    browser.web.during = () => {
      browser.ai.pause = { after: 150, until: new Promise<void>((resolve) => (resume = resolve)) }
    }
    await ask(user, 'Where was tea first drunk?')
    await screen.findByText(/^Tea was/)
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText('Stopped')).toBeVisible()
    await answered()
    resume()
    browser.ai.pause = undefined

    browser.ai.script.push({ reply: 'In China.' })
    await ask(user, 'So where?')
    expect(await screen.findByText('In China.')).toBeVisible()
    // The tool and its result went with the next question; the reply cut short did not.
    const sent = browser.sentToModel()
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(sent[3].content).toContain('Tea was first drunk in China.')
  })

  it('[UC-WEBCO-AGENT-001-S05] the next question is given the tools a failed question used, and not a question that used none', async () => {
    const { browser, user } = await open()
    // The model fails on the request that would send the tool's result back.
    browser.ai.script.push({ toolCalls: [read(ARTICLE)] })
    browser.web.during = () => (browser.ai.failWith = new Error('capacity'))
    await ask(user, 'Where was tea first drunk?')
    await answered()
    expect(browser.web.asked).toEqual([ARTICLE])

    // Fails on its first model request, before any tool ran.
    await ask(user, 'Are you there?')
    await answered()
    browser.ai.failWith = undefined

    browser.ai.script.push({ reply: 'In China.' })
    await ask(user, 'So where?')
    expect(await screen.findByText('In China.')).toBeVisible()
    const sent = browser.sentToModel()
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      expect.stringContaining('Where was tea first drunk?'),
      expect.stringContaining('So where?'),
    ])
  })
})
