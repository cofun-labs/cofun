// Choosing which model answers (UC-NOTICO-AGENT-002), as a user does it on the settings page and in the
// chat. Besides the screen, the tests look at the edges: what OpenRouter, DeepSeek, and the worker
// were sent.
import '@testing-library/jest-dom/vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { pageTab, type FakeNotionTab } from './notion-tab'
import { listed } from './openrouter'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const KEY = 'sk-or-v1-test-key'
const SOL = /^OpenAI: GPT-6.1 Sol/

async function openPanel(tab: FakeNotionTab = pageTab(), signedInAs = 'user_alice') {
  const browser = await FakeBrowser.start(tab, { signedInAs })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}

const backToChat = (user: UserEvent) => user.click(screen.getByRole('button', { name: 'Back' }))

const modelInUse = () => screen.getByLabelText('Model in use')

/** Sets up OpenRouter with `key` and a recommended model, from the settings page, and goes back to the chat. */
async function setUpOpenRouter(browser: FakeBrowser, user: UserEvent, model = SOL) {
  browser.openRouter.keys.add(KEY)
  await openSettings(user)
  await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
  await user.type(screen.getByLabelText('OpenRouter API key'), KEY)
  await user.click(await screen.findByRole('radio', { name: model }))
  await user.click(screen.getByRole('button', { name: 'Use OpenRouter' }))
  expect(modelInUse()).toHaveTextContent(model)
  await backToChat(user)
}

async function ask(user: UserEvent, question: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), `${question}{Enter}`)
}

const answered = () => screen.findByRole('button', { name: 'Send' })

/** The rows of the latest reply's details, opened from its "…" button. */
async function replyDetails(user: UserEvent) {
  await user.click(screen.getAllByRole('button', { name: 'Reply details' }).at(-1)!)
  const popover = screen.getByRole('dialog', { name: 'Reply details' })
  return [...popover.querySelectorAll('p')].map((row) => row.textContent)
}

describe('choosing the model', () => {
  it('[UC-NOTICO-AGENT-002-S01] the own model answers with the user key and a tool, and the worker never gets the key or the question', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )
    const before = browser.sentToWorker.length

    await ask(user, 'What does this page say?')
    expect(await screen.findByText('It is a fixture.')).toBeVisible()
    await answered()

    // Both model calls went to OpenRouter, with the user's key, for the chosen model.
    const { calls } = browser.openRouter
    expect(calls.map((c) => [c.key, c.model])).toEqual([
      [KEY, 'openai/gpt-6.1-sol'],
      [KEY, 'openai/gpt-6.1-sol'],
    ])
    // The tool ran in the extension and its result went back to the model.
    expect(calls[1].messages.some((m) => m.role === 'tool' && String(m.content).includes('Fixture page'))).toBe(true)
    // The hosted model was never asked, so no credits were spent.
    expect(browser.ai.calls).toEqual([])
    // Nothing the worker got, before or during the question, carries the key or the question.
    for (const sent of browser.sentToWorker) {
      expect(sent).not.toContain(KEY)
      expect(sent).not.toContain('What does this page say?')
    }
    expect(browser.sentToWorker.slice(before).some((sent) => sent.includes('/chat/completions'))).toBe(false)
  })

  it("[UC-NOTICO-SESSION-001-S14] with the user's own model, the title is asked of that model with their key, not of the worker", async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.titles.failWith = undefined
    // An apostrophe at one end is part of the title, not a quote around it.
    browser.openRouter.titles.script.push({ reply: "'90s fixture page summary" })
    browser.openRouter.ai.script.push({ reply: 'It is a fixture.' })
    const before = browser.sentToWorker.length

    await ask(user, 'What does this page say?')
    await screen.findByText('It is a fixture.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    // In the list, not only in the header above it.
    const list = await screen.findByRole('dialog', { name: 'Chats' })
    expect(await within(list).findByText("'90s fixture page summary")).toBeVisible()
    expect(browser.openRouter.titles.calls.map((c) => c.model)).toEqual(['openai/gpt-6.1-sol'])
    expect(browser.openRouter.requests.filter((r) => r.path === '/api/v1/chat/completions').map((r) => r.key)).toEqual([
      KEY,
      KEY,
    ])
    expect(browser.titles.calls).toEqual([])
    expect(browser.sentToWorker.slice(before).some((sent) => sent.includes('/chat/completions'))).toBe(false)
  })

  it("a reply's details name the own model and the tokens OpenRouter reported", async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.ai.usage = {
      prompt_tokens: 3000,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 2000 },
    }
    browser.openRouter.ai.script.push({ reply: 'It is a fixture.' })

    await ask(user, 'What does this page say?')
    await screen.findByText('It is a fixture.')
    await answered()

    expect(await replyDetails(user)).toEqual(['Tokens: 3k in (2k cached) · 40 out'])
    expect(screen.getByRole('note', { name: 'Answered by OpenAI: GPT-6.1 Sol' })).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-002-S02] another account on the same browser gets the hosted model and cannot see the key', async () => {
    const tab = pageTab()
    {
      const { browser, user } = await openPanel(tab, 'user_alice')
      await setUpOpenRouter(browser, user)
    }
    await closeBrowser()

    const { browser, user } = await openPanel(tab, 'user_bob')
    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.ai.calls).toHaveLength(1)
    expect(browser.openRouter.calls).toEqual([])

    await openSettings(user)
    expect(modelInUse()).toHaveTextContent('Auto')
    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    expect(screen.queryByText(/key is saved/)).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-AGENT-002-S03] a key OpenRouter rejects is reported as rejected', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    // The key was revoked on OpenRouter since.
    browser.openRouter.keys.clear()

    await ask(user, 'Hello?')
    expect(await screen.findByText(/OpenRouter rejected your key/)).toBeVisible()
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S04] after the key is removed, the hosted model answers', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove key' }))
    expect(modelInUse()).toHaveTextContent('Auto')
    await backToChat(user)

    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.openRouter.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S05] switching from the hosted model mid-conversation, the own model gets the conversation so far', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'The hosted answer.' })
    await ask(user, 'First question')
    await screen.findByText('The hosted answer.')
    await answered()

    await setUpOpenRouter(browser, user)
    browser.openRouter.ai.script.push({ reply: 'The own answer.' })
    await ask(user, 'A follow-up')
    expect(await screen.findByText('The own answer.')).toBeVisible()
    await answered()

    // The earlier exchange is still on screen, and went to the new model with the follow-up.
    expect(screen.getByText('The hosted answer.')).toBeVisible()
    const sent = JSON.stringify(browser.openRouter.calls[0].messages)
    expect(sent).toContain('First question')
    expect(sent).toContain('The hosted answer.')
    expect(sent).toContain('A follow-up')
    // Only the first question reached the hosted model.
    expect(browser.ai.calls).toHaveLength(1)
  })

  it('[UC-NOTICO-AGENT-002-S06] the own model still answers after the side panel is opened again', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await browser.openPanel()
    browser.openRouter.ai.script.push({ reply: 'Still mine.' })
    await ask(user, 'Hello?')
    expect(await screen.findByText('Still mine.')).toBeVisible()
    expect(browser.openRouter.calls.map((c) => c.key)).toEqual([KEY])
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S07] a search shows only models that can use tools, with their price, and one can be picked', async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.models.push(
      listed('google/gemma-5-27b', 'Google: Gemma 5 27B', 0.1, 0.4),
      { ...listed('google/gemma-5-9b', 'Google: Gemma 5 9B'), supported_parameters: ['temperature'] },
      listed('google/gemma-5-27b:batch', 'Google: Gemma 5 27B (batch)'),
      listed('~google/gemma-latest', 'Google: Gemma Latest'),
    )
    browser.openRouter.keys.add(KEY)
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    await user.type(await screen.findByRole('searchbox', { name: 'Search models' }), 'gemma')

    const results = screen.getByRole('list', { name: 'Search results' })
    const found = within(results).getAllByRole('radio')
    expect(found).toHaveLength(1)
    expect(found[0]).toHaveAccessibleName('Google: Gemma 5 27B $0.10 in · $0.40 out per million tokens · 200K context')

    await user.click(found[0])
    await user.type(screen.getByLabelText('OpenRouter API key'), KEY)
    await user.click(screen.getByRole('button', { name: 'Use OpenRouter' }))
    expect(modelInUse()).toHaveTextContent('Google: Gemma 5 27B')
  })

  it('[UC-NOTICO-AGENT-002-S08] checking a key and model says whether the model answered and can use tools', async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.keys.add(KEY)
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    await user.type(screen.getByLabelText('OpenRouter API key'), KEY)
    await user.click(await screen.findByRole('radio', { name: SOL }))

    browser.openRouter.ai.script.push({ toolCalls: [{ name: 'get_time', arguments: '{}' }] })
    await user.click(screen.getByRole('button', { name: 'Check key and model' }))
    expect(await screen.findByText('The model answered and can use tools.')).toBeVisible()

    browser.openRouter.ai.script.push({ reply: 'It is noon.' })
    await user.click(screen.getByRole('button', { name: 'Check key and model' }))
    expect(await screen.findByText(/answered but didn't use the tool/)).toBeVisible()

    browser.openRouter.keys.clear()
    await user.click(screen.getByRole('button', { name: 'Check key and model' }))
    expect(await screen.findByText(/OpenRouter rejected your key/)).toBeVisible()
  })

  it('a key removed in another window is not used, nor saved back, here', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    // The side panel of another window removes the key.
    const saved = Object.keys(browser.tab.storage.values).find((k) => k.startsWith('model:'))!
    await act(() => browser.tab.storage.local.set({ [saved]: { use: 'hosted' } }))

    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.openRouter.calls).toEqual([])
    await openSettings(user)
    expect(modelInUse()).toHaveTextContent('Auto')
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)
  })

  it('contacts OpenRouter only once the user picks it', async () => {
    const { browser, user } = await openPanel()
    await openSettings(user)
    expect(browser.openRouter.requests).toEqual([])

    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    await screen.findByRole('radio', { name: SOL })
    // The model list is public: no key goes with it.
    expect(browser.openRouter.requests).toEqual([{ path: '/api/v1/models', key: undefined }])
  })
})

describe('switching the model from the chat', () => {
  const chip = (name: string) => screen.getByRole('button', { name: `Model: ${name}` })

  it('[UC-NOTICO-AGENT-002-S10] a follow-up goes to the model picked from the chat, with the conversation so far', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.ai.script.push({ reply: 'From Sol.' }, { reply: 'From Sonnet.' })
    await ask(user, 'First question')
    await screen.findByText('From Sol.')
    await answered()

    await user.click(chip('GPT-6.1 Sol'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    expect(within(menu).getByRole('menuitemradio', { name: /^GPT-6.1 Sol/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(await within(menu).findByRole('menuitemradio', { name: 'Claude Sonnet 5.5' }))

    // Still in the chat, now showing the new model.
    expect(screen.queryByRole('menu', { name: 'Model' })).not.toBeInTheDocument()
    expect(chip('Claude Sonnet 5.5')).toHaveFocus()
    await ask(user, 'A follow-up')
    expect(await screen.findByText('From Sonnet.')).toBeVisible()

    const last = browser.openRouter.calls.at(-1)!
    expect(last.model).toBe('anthropic/claude-sonnet-5.5')
    expect(JSON.stringify(last.messages)).toContain('From Sol.')
    expect(browser.ai.calls).toEqual([])
  })

  it('the hosted model can be picked from the chat, and the own model again after it', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await user.click(chip('GPT-6.1 Sol'))
    await user.click(screen.getByRole('menuitemradio', { name: /^Auto/ }))
    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    await answered()
    expect(browser.openRouter.calls).toEqual([])

    // The key is kept: the own model is one pick away.
    await user.click(chip('Auto'))
    await user.click(await screen.findByRole('menuitemradio', { name: /^GPT-6.1 Sol/ }))
    expect(chip('GPT-6.1 Sol')).toBeVisible()
  })

  it('without a key, the menu offers the hosted model and leads to the settings page, contacting no one', async () => {
    const { browser, user } = await openPanel()
    await user.click(chip('Auto'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Auto'])
    expect(browser.openRouter.requests).toEqual([])

    await user.click(within(menu).getByRole('menuitem', { name: 'Set up your own model…' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Model' })).toBeVisible()
  })

  it('works from the keyboard: the arrows move through it, and Escape closes it on the button', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await user.click(chip('GPT-6.1 Sol'))
    // The recommended models, in their order, once OpenRouter's list is in.
    await screen.findByRole('menuitemradio', { name: /^Claude Sonnet 5.5/ })
    expect(screen.getByRole('menuitemradio', { name: /^Auto/ })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: /^Claude Sonnet 5.5/ })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'More models…' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Model' })).not.toBeInTheDocument()
    expect(chip('GPT-6.1 Sol')).toHaveFocus()
  })
})

describe('DeepSeek with the user key', () => {
  const DS_KEY = 'sk-deepseek-test-key'
  const FLASH = /^DeepSeek V4.1 Flash/
  const chip = (name: string) => screen.getByRole('button', { name: `Model: ${name}` })

  /** Sets up DeepSeek with its key and `model`, from the settings page, and goes back to the chat. */
  async function setUpDeepSeek(browser: FakeBrowser, user: UserEvent, model = FLASH) {
    browser.deepSeek.keys.add(DS_KEY)
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'DeepSeek, with your key' }))
    await user.type(screen.getByLabelText('DeepSeek API key'), DS_KEY)
    await user.click(screen.getByRole('radio', { name: model }))
    await user.click(screen.getByRole('button', { name: 'Use DeepSeek' }))
    expect(modelInUse()).toHaveTextContent(model)
    await backToChat(user)
  }

  it('[UC-NOTICO-AGENT-002-S11] a DeepSeek model answers with the user key and a tool, and no one else gets the key or the question', async () => {
    const { browser, user } = await openPanel()
    await setUpDeepSeek(browser, user)
    browser.deepSeek.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )
    const before = browser.sentToWorker.length

    await ask(user, 'What does this page say?')
    expect(await screen.findByText('It is a fixture.')).toBeVisible()
    await answered()

    const { calls } = browser.deepSeek
    expect(calls.map((c) => [c.key, c.model])).toEqual([
      [DS_KEY, 'deepseek-flash'],
      [DS_KEY, 'deepseek-flash'],
    ])
    expect(calls[1].messages.some((m) => m.role === 'tool' && String(m.content).includes('Fixture page'))).toBe(true)
    // Asked as pi's catalog says to ask DeepSeek: without thinking first.
    expect(calls[0].thinking).toEqual({ type: 'disabled' })
    expect(browser.ai.calls).toEqual([])
    expect(browser.openRouter.requests).toEqual([])
    for (const sent of browser.sentToWorker) {
      expect(sent).not.toContain(DS_KEY)
      expect(sent).not.toContain('What does this page say?')
    }
    expect(browser.sentToWorker.slice(before).some((sent) => sent.includes('/chat/completions'))).toBe(false)
  })

  it("a reply's details name the DeepSeek model and the tokens DeepSeek reported", async () => {
    const { browser, user } = await openPanel()
    await setUpDeepSeek(browser, user)
    // DeepSeek reports its cache hits in a field of its own.
    browser.deepSeek.ai.usage = { prompt_tokens: 900, completion_tokens: 30, prompt_cache_hit_tokens: 600 }
    browser.deepSeek.ai.script.push({ reply: 'It is a fixture.' })

    await ask(user, 'What does this page say?')
    await screen.findByText('It is a fixture.')
    await answered()

    expect(await replyDetails(user)).toEqual(['Tokens: 900 in (600 cached) · 30 out'])
    expect(screen.getByRole('note', { name: /^Answered by DeepSeek V4.1 Flash/ })).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-002-S12] switching between OpenRouter and DeepSeek uses each one with its own key, never asked again', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)
    browser.deepSeek.ai.script.push({ reply: 'From DeepSeek.' }, { reply: 'DeepSeek again.' })
    browser.openRouter.ai.script.push({ reply: 'From Sol.' })

    await ask(user, 'First question')
    expect(await screen.findByText('From DeepSeek.')).toBeVisible()
    await answered()

    // To OpenRouter from the chat: its saved key and model are one pick away.
    await user.click(chip('DeepSeek V4.1 Flash'))
    await user.click(await screen.findByRole('menuitemradio', { name: /^GPT-6.1 Sol/ }))
    await ask(user, 'Second question')
    expect(await screen.findByText('From Sol.')).toBeVisible()
    await answered()

    // Back to DeepSeek from the settings page, with no key to enter.
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'DeepSeek, with your key' }))
    expect(modelInUse()).toHaveTextContent(FLASH)
    expect(screen.queryByLabelText('DeepSeek API key')).not.toBeInTheDocument()
    await backToChat(user)
    await ask(user, 'Third question')
    expect(await screen.findByText('DeepSeek again.')).toBeVisible()

    expect(browser.deepSeek.calls.map((c) => c.key)).toEqual([DS_KEY, DS_KEY])
    expect(browser.openRouter.calls.map((c) => c.key)).toEqual([KEY])
    // The follow-ups went on with the conversation so far.
    expect(JSON.stringify(browser.deepSeek.calls[1].messages)).toContain('From Sol.')
    // Neither key went to the other service.
    expect(browser.deepSeek.requests.every((r) => r.key === DS_KEY)).toBe(true)
    expect(browser.openRouter.requests.every((r) => r.key === undefined || r.key === KEY)).toBe(true)
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S17] the chat menu lists the hosted model and DeepSeek models by name only once a DeepSeek key is saved', async () => {
    const { browser, user } = await openPanel()
    await user.click(chip('Auto'))
    expect(screen.queryByRole('group', { name: 'DeepSeek' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    await setUpDeepSeek(browser, user)
    await user.click(chip('DeepSeek V4.1 Flash'))
    const group = screen.getByRole('group', { name: 'DeepSeek' })
    expect(
      within(screen.getByRole('menu', { name: 'Model' }))
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Auto', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Pro'])
    expect(within(group).getByRole('menuitemradio', { name: FLASH })).toHaveAttribute('aria-checked', 'true')

    await user.click(within(group).getByRole('menuitemradio', { name: /^DeepSeek V4 Pro/ }))
    expect(chip('DeepSeek V4 Pro')).toHaveFocus()
    browser.deepSeek.ai.script.push({ reply: 'From Pro.' })
    await ask(user, 'Hello?')
    expect(await screen.findByText('From Pro.')).toBeVisible()
    expect(browser.deepSeek.calls.map((c) => c.model)).toEqual(['deepseek-v4-pro'])
    // Without an OpenRouter key, the menu never contacted OpenRouter.
    expect(browser.openRouter.requests).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S14] a key DeepSeek rejects, and a balance that ran out, are each said plainly', async () => {
    const { browser, user } = await openPanel()
    await setUpDeepSeek(browser, user)

    browser.deepSeek.outOfBalance = true
    await ask(user, 'Hello?')
    expect(await screen.findByText(/Your DeepSeek balance has run out. Top it up on DeepSeek/)).toBeVisible()
    await answered()

    browser.deepSeek.outOfBalance = false
    browser.deepSeek.keys.clear()
    await ask(user, 'Hello again?')
    expect(await screen.findByText(/DeepSeek rejected your key. Check it on the settings page./)).toBeVisible()
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S15] when DeepSeek turns requests away for too many, the question stops and nothing is sent again', async () => {
    const { browser, user } = await openPanel()
    await setUpDeepSeek(browser, user)
    browser.deepSeek.rateLimited = true

    await ask(user, 'Hello?')
    expect(await screen.findByText(/DeepSeek is getting too many requests .* Wait a minute/)).toBeVisible()
    await answered()
    expect(browser.deepSeek.requests).toHaveLength(1)
    expect(browser.ai.calls).toEqual([])
  })

  it('checks a DeepSeek key and model', async () => {
    const { browser, user } = await openPanel()
    browser.deepSeek.keys.add(DS_KEY)
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'DeepSeek, with your key' }))
    await user.type(screen.getByLabelText('DeepSeek API key'), DS_KEY)
    await user.click(screen.getByRole('radio', { name: FLASH }))

    browser.deepSeek.ai.script.push({ toolCalls: [{ name: 'get_time', arguments: '{}' }] })
    await user.click(screen.getByRole('button', { name: 'Check key and model' }))
    expect(await screen.findByText('The model answered and can use tools.')).toBeVisible()
    expect(browser.deepSeek.calls.map((c) => [c.key, c.model])).toEqual([[DS_KEY, 'deepseek-flash']])

    browser.deepSeek.keys.clear()
    await user.click(screen.getByRole('button', { name: 'Check key and model' }))
    expect(await screen.findByText(/DeepSeek rejected your key/)).toBeVisible()
  })

  it('shows each model with its price and context, and contacts DeepSeek only to ask it', async () => {
    const { browser, user } = await openPanel()
    await openSettings(user)
    await user.click(screen.getByRole('radio', { name: 'DeepSeek, with your key' }))
    const listed = within(screen.getByRole('list', { name: "DeepSeek's models" })).getAllByRole('radio')
    expect(listed).toHaveLength(2)
    expect(listed[0]).toHaveAccessibleName('DeepSeek V4.1 Flash $0.30 in · $1.20 out per million tokens · 1M context')
    expect(browser.deepSeek.requests).toEqual([])
    expect(browser.openRouter.requests).toEqual([])
  })

  it('removing a key shows the choice saved now, when another window switched services meanwhile', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)
    await openSettings(user)
    // The user switches to OpenRouter and back here, so this page shows DeepSeek's setup.
    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    await user.click(screen.getByRole('radio', { name: 'DeepSeek, with your key' }))
    expect(screen.getByText(/Your DeepSeek key is saved/)).toBeVisible()

    // The side panel of another window switches to OpenRouter.
    const saved = Object.keys(browser.tab.storage.values).find((k) => k.startsWith('model:'))!
    const settings = browser.tab.storage.values[saved] as Record<string, unknown>
    await act(() => browser.tab.storage.local.set({ [saved]: { ...settings, use: 'openrouter' } }))
    await user.click(screen.getByRole('button', { name: 'Remove key' }))

    expect(screen.getByRole('radio', { name: 'OpenRouter, with your key' })).toBeChecked()
    expect(modelInUse()).toHaveTextContent(SOL)
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(DS_KEY)
  })

  it("removing the DeepSeek key keeps OpenRouter's", async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)

    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove key' }))
    expect(modelInUse()).toHaveTextContent('Auto')
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(DS_KEY)

    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    expect(modelInUse()).toHaveTextContent(SOL)
    expect(screen.getByText(/Your OpenRouter key is saved/)).toBeVisible()
  })
})
