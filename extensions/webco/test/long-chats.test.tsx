// Continuing a long chat (UC-WEBCO-CHAT-007), as a user meets it in the side panel: once a chat
// fills the model's request budget, the earlier work is summarized and the question goes on; a saved
// chat keeps its messages and its summary. Besides the screen, the tests look only at what the
// models were sent. How the summary requests are cut, and what they hold, is tested in
// worker/test/extension.test.ts.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { listed } from '@cofun/panel-test/openrouter'
import { FakeTab, webPage } from './tab'
import { closeBrowser, FakeBrowser } from './browser'

afterEach(closeBrowser)

const ARTICLE = 'https://news.example.com/2026/rivers'
const KEY = 'sk-or-v1-test-key'
/** What every summary sent to a model opens with. */
const SUMMARY = /^Summary of earlier conversation, for context only\./

/** The side panel open next to an article on a site the user allowed, signed in with credits to spare. */
async function open() {
  const tab = new FakeTab(ARTICLE)
  tab.title = 'Rivers | News'
  tab.dom = webPage({ title: 'Rivers | News', main: '<p>Rivers are rising.</p>', url: ARTICLE })
  tab.allowed.add('https://news.example.com/*')
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  // A request that fills most of the hosted model's window costs more than the free credits.
  await browser.grantCredits('user_alice', 1000, 30)
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const call = (name: string, args: object = {}) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

async function ask(user: UserEvent, question: string) {
  await user.click(screen.getByRole('textbox', { name: 'Message' }))
  await user.paste(question)
  await user.keyboard('{Enter}')
}

const answered = () => screen.findByRole('button', { name: 'Send' })

/** What a model call was sent: its messages' roles and text. */
type Sent = { role: string; content?: unknown; tool_calls?: unknown }[]
const text = (message: Sent[number] | undefined) => (typeof message?.content === 'string' ? message.content : '')

/** Turns OpenRouter on with KEY in Settings, with GPT-6.1 Sol on, and picks Sol in the composer. */
async function useOwnModel(browser: FakeBrowser, user: UserEvent) {
  browser.openRouter.keys.add(KEY)
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  const openRouter = within(await screen.findByRole('group', { name: 'OpenRouter' }))
  await user.click(openRouter.getByRole('switch', { name: 'OpenRouter' }))
  await user.click(openRouter.getByLabelText('OpenRouter API key'))
  await user.paste(KEY)
  await user.keyboard('{Enter}')
  expect(await openRouter.findByText(/^Key works/)).toBeVisible()
  await waitFor(() => expect(openRouter.getByRole('switch', { name: 'OpenAI: GPT-6.1 Sol' })).toBeVisible())
  await user.click(openRouter.getByRole('switch', { name: 'OpenAI: GPT-6.1 Sol' }))
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await user.click(screen.getByRole('button', { name: /^Model: / }))
  await user.click(
    within(screen.getByRole('menu', { name: 'Model' })).getByRole('menuitemradio', { name: 'GPT-6.1 Sol' }),
  )
}

/**
 * Asks a question in which the AI reads the tab twice, the second read leaving the hosted model's
 * window nearly full, so the request after it summarizes the first read. Resolves once it is answered.
 */
async function askUntilCompacted(browser: FakeBrowser, user: UserEvent) {
  // 70% of the hosted model's 1,048,576-token window.
  const full = { prompt_tokens: 734_100, completion_tokens: 5, total_tokens: 734_105 }
  browser.ai.script.push(
    call('read_current_tab'),
    { ...call('read_current_tab'), usage: full },
    { reply: 'The article was read once already.' },
    { reply: 'Rivers are rising, twice over.' },
  )
  await ask(user, 'Read this article twice, then tell me what it says.')
  expect(await screen.findByText('Rivers are rising, twice over.')).toBeVisible()
  await answered()
}

describe('continuing a long chat', () => {
  it('[UC-WEBCO-CHAT-007-S01] a question that fills the budget summarizes the earlier work and answers, without reading again', async () => {
    const { browser, user } = await open()

    await askUntilCompacted(browser, user)

    const sent = browser.ai.calls.map((c) => c.inputs.messages as Sent)
    expect(sent).toHaveLength(4)
    // The third request asks for the summary, with no tools to call; the fourth answers from it.
    expect(browser.ai.calls[2].inputs.tools).toBeUndefined()
    expect(text(sent[3][1])).toMatch(SUMMARY)
    expect(text(sent[3][1])).toContain('The article was read once already.')
    expect(text(sent[3][2])).toContain('Read this article twice, then tell me what it says.')
    // The newest read is still there as it was, and the tab was read only twice.
    expect(sent[3].at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('Rivers are rising.') })
    expect(browser.tab.injections).toHaveLength(2)
  })

  it('[UC-WEBCO-CHAT-007-S02] a summarized chat opened again shows its messages, and a follow-up uses the saved summary', async () => {
    const { browser, user } = await open()
    await askUntilCompacted(browser, user)
    const summary = text((browser.ai.calls[3].inputs.messages as Sent)[1])
    await user.click(screen.getByRole('button', { name: 'New chat' }))

    // The panel opens again, and the chat is opened from the list.
    await browser.openPanel()
    await user.click(await screen.findByRole('button', { name: 'Chats' }))
    await user.click(await screen.findByRole('button', { name: /Read this article twice/ }))
    expect(await screen.findByText('Rivers are rising, twice over.')).toBeVisible()
    expect(screen.getAllByText('Read this article twice, then tell me what it says.').at(-1)).toBeVisible()
    browser.ai.script.push({ reply: 'They rise in spring.' })
    await ask(user, 'When do they rise?')

    expect(await screen.findByText('They rise in spring.')).toBeVisible()
    // One request, which starts from the summary made before: nothing is summarized again.
    expect(browser.ai.calls).toHaveLength(5)
    const followUp = browser.ai.calls[4].inputs.messages as Sent
    expect(text(followUp[1])).toBe(summary)
    expect(text(followUp.at(-1))).toBe('When do they rise?')
  })

  it('[UC-WEBCO-CHAT-007-S03] a chat too long for a smaller model chosen next is summarized in order by it, which then answers', async () => {
    const { browser, user } = await open()
    // A reply that fits the hosted model's window, but not the 200,000 tokens of GPT-6.1 Sol.
    browser.ai.script.push({ reply: `Archive start. ${'x'.repeat(580_000)} Archive end.` })
    await ask(user, 'The launch code is OSPREY-73. Write out the archive.')
    expect(await screen.findByText(/Archive end\./)).toBeVisible()
    await answered()
    await useOwnModel(browser, user)
    browser.openRouter.ai.script.push(
      { reply: 'Goal: keep OSPREY-73. Progress: the archive started.' },
      { reply: 'Goal: keep OSPREY-73. Progress: the archive ended.' },
      { reply: 'OSPREY-73' },
    )

    await ask(user, 'What was the launch code?')

    expect(await screen.findByText('OSPREY-73')).toBeVisible()
    const [first, second, reply] = browser.openRouter.calls.map((c) => c.messages)
    expect(browser.openRouter.calls).toHaveLength(3)
    // The older history, in order: its start, then its end with what was summarized before it.
    expect(text(first[1])).toContain('The launch code is OSPREY-73.')
    expect(text(first[1])).not.toContain('Archive end.')
    expect(text(second[1])).toContain('Archive end.')
    expect(text(second[1])).toContain('Goal: keep OSPREY-73. Progress: the archive started.')
    expect(text(reply[1])).toMatch(SUMMARY)
    expect(text(reply.at(-1))).toBe('What was the launch code?')
  })

  it('[UC-WEBCO-CHAT-007-S04] a model with a window under 200,000 tokens says so, and is not sent the question', async () => {
    const { browser, user } = await open()
    browser.openRouter.models = browser.openRouter.models.map((m) =>
      m.id === 'openai/gpt-6.1-sol' ? { ...listed(m.id, m.name), context_length: 199_999 } : m,
    )
    await useOwnModel(browser, user)

    await ask(user, 'Is this window large enough?')

    expect(await screen.findByText(/Choose a model with a context window of at least 200,000 tokens\./)).toBeVisible()
    await answered()
    expect(browser.openRouter.calls).toEqual([])
    expect(browser.ai.calls).toEqual([])
  })
})
