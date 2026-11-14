// Choosing which model answers (UC-NOTICO-AGENT-002), as a user does it: providers, keys, and models in
// Settings, and the model menu in the chat. Besides the screen, the tests look at the edges: what
// OpenRouter, DeepSeek, and the worker were sent.
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageTab, type FakeNotionTab } from './notion-tab'
import { listed } from './openrouter'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const KEY = 'sk-or-v1-test-key'
const DS_KEY = 'sk-deepseek-test-key'

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

/** A provider on the settings page. */
const provider = (name: 'OpenRouter' | 'DeepSeek') => within(screen.getByRole('group', { name }))
const providerSwitch = (name: 'OpenRouter' | 'DeepSeek') => provider(name).getByRole('switch', { name })
const modelSwitch = (name: 'OpenRouter' | 'DeepSeek', model: string | RegExp) =>
  provider(name).getByRole('switch', { name: model })

/** Switches a provider on and checks `key` with Enter, from the settings page, until it works. */
async function turnOn(user: UserEvent, name: 'OpenRouter' | 'DeepSeek', key: string) {
  await user.click(providerSwitch(name))
  await user.type(provider(name).getByLabelText(`${name} API key`), `${key}{Enter}`)
  expect(await provider(name).findByText(/^Key works/)).toBeVisible()
}

const chip = (name: string) => screen.getByRole('button', { name: `Model: ${name}` })

/** Picks `model` from the composer's model menu, whatever it shows now. */
async function pick(user: UserEvent, model: string | RegExp) {
  await user.click(screen.getByRole('button', { name: /^Model: / }))
  await user.click(within(screen.getByRole('menu', { name: 'Model' })).getByRole('menuitemradio', { name: model }))
}

/**
 * Turns OpenRouter on with KEY from the settings page, switches GPT-6.1 Sol on there as well as the
 * model that starts on, and picks Sol in the composer.
 */
async function setUpOpenRouter(browser: FakeBrowser, user: UserEvent) {
  browser.openRouter.keys.add(KEY)
  await openSettings(user)
  await turnOn(user, 'OpenRouter', KEY)
  await user.click(await waitFor(() => modelSwitch('OpenRouter', 'OpenAI: GPT-6.1 Sol')))
  await backToChat(user)
  await pick(user, 'GPT-6.1 Sol')
  expect(chip('GPT-6.1 Sol')).toBeVisible()
}

/** Turns DeepSeek on with DS_KEY from the settings page, switches both its models on, and picks Flash. */
async function setUpDeepSeek(browser: FakeBrowser, user: UserEvent) {
  browser.deepSeek.keys.add(DS_KEY)
  await openSettings(user)
  await turnOn(user, 'DeepSeek', DS_KEY)
  await user.click(modelSwitch('DeepSeek', 'DeepSeek V4 Pro'))
  await backToChat(user)
  await pick(user, 'DeepSeek V4.1 Flash')
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

/** The items of the open model menu, in order: the group headings are not items. */
const menuItems = () =>
  within(screen.getByRole('menu', { name: 'Model' }))
    .getAllByRole('menuitemradio')
    .map((item) => item.textContent)

/** The account's model settings, as saved on the device. */
const savedSettings = (browser: FakeBrowser) => {
  const key = Object.keys(browser.tab.storage.values).find((k) => k.startsWith('model:'))!
  return { key, value: browser.tab.storage.values[key] as Record<string, unknown> }
}

describe('answering with the own model', () => {
  it('[UC-NOTICO-AGENT-002-S01][UC-NOTICO-CHAT-003-S15] the own model answers with the user key and a tool, and the worker never gets the key or the question', async () => {
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

    // [UC-NOTICO-CHAT-003-S15] The user's own model spends no credits: the reply shows no cost.
    expect(screen.queryByText(/\bcredits?$/)).not.toBeInTheDocument()
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
    expect(chip('Auto')).toBeVisible()
    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.ai.calls).toHaveLength(1)
    expect(browser.openRouter.calls).toEqual([])

    await openSettings(user)
    expect(providerSwitch('OpenRouter')).not.toBeChecked()
    await user.click(providerSwitch('OpenRouter'))
    expect(provider('OpenRouter').getByLabelText('OpenRouter API key')).toHaveValue('')
    expect(provider('OpenRouter').queryByText(/^Key works/)).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-AGENT-002-S03] a key OpenRouter turns away is said in the question, and marks OpenRouter in Settings', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    // The key was revoked on OpenRouter since.
    browser.openRouter.keys.clear()

    await ask(user, 'Hello?')
    expect(await screen.findByText(/OpenRouter turned your key away/)).toBeVisible()
    await answered()
    expect(browser.ai.calls).toEqual([])
    // The menu stays as it is: the question said so, and Settings shows it.
    expect(chip('GPT-6.1 Sol')).toBeVisible()

    await openSettings(user)
    expect(provider('OpenRouter').getByText('Key stopped working')).toBeVisible()
    expect(provider('OpenRouter').getByRole('alert')).toHaveTextContent(/OpenRouter turned this key away on Nov 8/)
    expect(provider('OpenRouter').getByRole('button', { name: 'Check again' })).toBeVisible()
    expect(provider('OpenRouter').getByRole('button', { name: 'Remove key' })).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-002-S22] checking a key that stopped working again clears the mark, and removing it deletes it', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.keys.clear()
    await ask(user, 'Hello?')
    await screen.findByText(/OpenRouter turned your key away/)
    await answered()

    await openSettings(user)
    // Still turned away: the mark stays, and the check says why.
    await user.click(provider('OpenRouter').getByRole('button', { name: 'Check again' }))
    expect(await provider('OpenRouter').findByText(/OpenRouter doesn't accept this key/)).toBeVisible()
    expect(provider('OpenRouter').getByText('Key stopped working')).toBeVisible()

    // The user fixed it on OpenRouter: the same key passes again.
    browser.openRouter.keys.add(KEY)
    await user.click(provider('OpenRouter').getByRole('button', { name: 'Check again' }))
    expect(await provider('OpenRouter').findByText(/^Key works/)).toBeVisible()
    expect(provider('OpenRouter').queryByText('Key stopped working')).not.toBeInTheDocument()
    expect(savedSettings(browser).value.openRouter).not.toHaveProperty('rejectedAt')

    await user.click(provider('OpenRouter').getByRole('button', { name: 'Remove key' }))
    expect(providerSwitch('OpenRouter')).not.toBeChecked()
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)
  })

  it('[UC-NOTICO-AGENT-002-S04] after the key is removed, the hosted model answers', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await openSettings(user)
    await user.click(provider('OpenRouter').getByRole('button', { name: 'Remove key' }))
    await backToChat(user)
    expect(chip('Auto')).toBeVisible()

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
    expect(await screen.findByRole('button', { name: 'Model: GPT-6.1 Sol' })).toBeVisible()
    browser.openRouter.ai.script.push({ reply: 'Still mine.' })
    await ask(user, 'Hello?')
    expect(await screen.findByText('Still mine.')).toBeVisible()
    expect(browser.openRouter.calls.map((c) => c.key)).toEqual([KEY])
    expect(browser.ai.calls).toEqual([])
  })

  it('a key removed in another window is not used, nor saved back, here', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    // The side panel of another window removes the key.
    const { key, value } = savedSettings(browser)
    await act(() => browser.tab.storage.local.set({ [key]: { chosen: value.chosen } }))

    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.openRouter.calls).toEqual([])
    await openSettings(user)
    expect(providerSwitch('OpenRouter')).not.toBeChecked()
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)
  })

  it('settings saved in the old shape are turned into the new one, keeping the keys and the model in use', async () => {
    const tab = pageTab()
    const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
    const sol = {
      id: 'openai/gpt-6.1-sol',
      name: 'OpenAI: GPT-6.1 Sol',
      contextLength: 200_000,
      price: { input: 2, output: 10 },
    }
    tab.storage.values['model:user_alice'] = {
      use: 'openrouter',
      openRouter: { key: KEY, model: sol },
      deepSeek: { key: DS_KEY, model: 'deepseek-flash' },
    }
    await browser.openPanel()
    const user = userEvent.setup()
    browser.openRouter.keys.add(KEY)

    expect(await screen.findByRole('button', { name: 'Model: GPT-6.1 Sol' })).toBeVisible()
    expect(savedSettings(browser).value).toEqual({
      openRouter: { on: true, key: KEY, models: [sol] },
      deepSeek: { on: true, key: DS_KEY, models: ['deepseek-flash'] },
      chosen: { service: 'openrouter', model: sol.id, name: sol.name },
    })
    await user.click(chip('GPT-6.1 Sol'))
    expect(menuItems()).toEqual(['Auto', 'GPT-6.1 Sol', 'DeepSeek V4.1 Flash'])
  })
})

describe('turning a provider on and checking its key', () => {
  it('[UC-NOTICO-AGENT-002-S08] a key that works is checked without asking a model, saved, and starts with the first recommended model on', async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.keys.add(KEY)
    browser.openRouter.limitRemaining = 4.2
    await openSettings(user)
    // Nothing is sent to OpenRouter until there is a key to check.
    await user.click(providerSwitch('OpenRouter'))
    const field = provider('OpenRouter').getByLabelText('OpenRouter API key')
    const button = provider('OpenRouter').getByRole('button', { name: 'Check key' })
    expect(button).toBeDisabled()
    expect(browser.openRouter.requests).toEqual([])

    // The check is held: while it runs, the field and the button are locked.
    let answer!: () => void
    browser.openRouter.checks = new Promise((resolve) => (answer = resolve))
    await user.type(field, KEY)
    await user.click(button)
    expect(await provider('OpenRouter').findByText('Asking OpenRouter whether this key works…')).toBeVisible()
    expect(field).toHaveAttribute('readonly')
    expect(provider('OpenRouter').getByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)

    answer()
    expect(await provider('OpenRouter').findByText('Key works · US$4.20 left on this key')).toBeVisible()
    // Only the key endpoint got the key, and then the public list, without it; no model was asked.
    expect(browser.openRouter.requests).toEqual([
      { path: '/api/v1/key', key: KEY },
      { path: '/api/v1/models', key: undefined },
    ])
    expect(browser.openRouter.calls).toEqual([])
    expect(savedSettings(browser).value.openRouter).toMatchObject({ on: true, key: KEY })
    // The first recommended model is on, so the provider is usable at once.
    expect(await waitFor(() => modelSwitch('OpenRouter', 'Anthropic: Claude Sonnet 5.5'))).toBeChecked()
    expect(modelSwitch('OpenRouter', 'OpenAI: GPT-6.1 Sol')).not.toBeChecked()
    expect(provider('OpenRouter').getByLabelText('Saved OpenRouter key')).toHaveTextContent('sk-or-v1-••••••••-key')

    await backToChat(user)
    await user.click(chip('Auto'))
    expect(menuItems()).toEqual(['Auto', 'Claude Sonnet 5.5'])
  })

  it("[UC-NOTICO-AGENT-002-S08] a DeepSeek key that works shows DeepSeek's balance and starts with its first model on", async () => {
    const { browser, user } = await openPanel()
    browser.deepSeek.keys.add(DS_KEY)
    await openSettings(user)
    await turnOn(user, 'DeepSeek', DS_KEY)

    expect(provider('DeepSeek').getByText('Key works · ¥38.50 balance')).toBeVisible()
    expect(browser.deepSeek.requests).toEqual([{ path: '/user/balance', key: DS_KEY }])
    expect(browser.deepSeek.calls).toEqual([])
    const models = within(provider('DeepSeek').getByRole('list', { name: "DeepSeek's models" })).getAllByRole('switch')
    expect(models.map((m) => [m.getAttribute('aria-label'), m.getAttribute('aria-checked')])).toEqual([
      ['DeepSeek V4.1 Flash', 'true'],
      ['DeepSeek V4 Pro', 'false'],
    ])
    expect(models[0]).toHaveAccessibleDescription('$0.30 in · $1.20 out per million tokens · 1M context')
    expect(browser.openRouter.requests).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S19] a key that fails is not saved, and the reason is said: rejected, or no money left', async () => {
    const { browser, user } = await openPanel()
    await openSettings(user)
    await user.click(providerSwitch('DeepSeek'))
    const field = provider('DeepSeek').getByLabelText('DeepSeek API key')
    await user.type(field, `${DS_KEY}{Enter}`)
    expect(await provider('DeepSeek').findByRole('alert')).toHaveTextContent(
      "DeepSeek doesn't accept this key. Copy it again from platform.deepseek.com and paste it here.",
    )
    // The field keeps what was pasted, so it can be fixed.
    expect(field).toHaveValue(DS_KEY)
    expect(field).toHaveAttribute('aria-invalid', 'true')

    browser.deepSeek.keys.add(DS_KEY)
    browser.deepSeek.outOfBalance = true
    await user.click(provider('DeepSeek').getByRole('button', { name: 'Check key' }))
    expect(
      await provider('DeepSeek').findByText(/The key works, but its DeepSeek account has no money left/),
    ).toBeVisible()
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(DS_KEY)
    expect(provider('DeepSeek').queryByRole('list')).not.toBeInTheDocument()
  })

  it("[UC-NOTICO-AGENT-002-S19] a key whose check OpenRouter can't answer is not saved: unreachable, or no money left on the key", async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.keys.add(KEY)
    browser.openRouter.unreachable = true
    await openSettings(user)
    await user.click(providerSwitch('OpenRouter'))
    await user.type(provider('OpenRouter').getByLabelText('OpenRouter API key'), `${KEY}{Enter}`)
    expect(await provider('OpenRouter').findByRole('alert')).toHaveTextContent(
      "OpenRouter couldn't be reached. Check your connection, then try again.",
    )

    browser.openRouter.unreachable = false
    browser.openRouter.limitRemaining = 0
    await user.click(provider('OpenRouter').getByRole('button', { name: 'Check key' }))
    expect(await provider('OpenRouter').findByRole('alert')).toHaveTextContent(
      'The key works, but its OpenRouter account has no money left. Add credit at openrouter.ai, then check again.',
    )
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)
  })

  it('[UC-NOTICO-AGENT-002-S19] a check that gets no answer gives up after 15 seconds, and saves nothing', async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.keys.add(KEY)
    browser.openRouter.checks = new Promise(() => {})
    await openSettings(user)
    await user.click(providerSwitch('OpenRouter'))
    await user.type(provider('OpenRouter').getByLabelText('OpenRouter API key'), KEY)

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() })
    fireEvent.click(provider('OpenRouter').getByRole('button', { name: 'Check key' }))
    await act(() => vi.advanceTimersByTimeAsync(14_999))
    expect(provider('OpenRouter').getByRole('button', { name: 'Checking…' })).toBeDisabled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })

    expect(await provider('OpenRouter').findByRole('alert')).toHaveTextContent(
      "OpenRouter didn't answer in time. Check your connection, then try again.",
    )
    expect(provider('OpenRouter').getByRole('button', { name: 'Check key' })).toBeEnabled()
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(KEY)
  })

  it('[UC-NOTICO-AGENT-002-S23] switching a provider off keeps its key, and on again offers its models with no key to paste', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await openSettings(user)
    await user.click(providerSwitch('OpenRouter'))
    expect(provider('OpenRouter').queryByRole('list')).not.toBeInTheDocument()
    expect(savedSettings(browser).value.openRouter).toMatchObject({ on: false, key: KEY })
    await backToChat(user)
    // Sol is no longer offered, so Auto answers, and the composer says so.
    expect(chip('Auto')).toBeVisible()
    await user.click(chip('Auto'))
    expect(menuItems()).toEqual(['Auto'])
    await user.keyboard('{Escape}')

    await openSettings(user)
    await user.click(providerSwitch('OpenRouter'))
    expect(provider('OpenRouter').queryByLabelText('OpenRouter API key')).not.toBeInTheDocument()
    expect(modelSwitch('OpenRouter', 'OpenAI: GPT-6.1 Sol')).toBeChecked()
    await backToChat(user)
    expect(chip('GPT-6.1 Sol')).toBeVisible()
    // Switching it on again sent nothing to check.
    expect(browser.openRouter.requests.filter((r) => r.path === '/api/v1/key')).toHaveLength(1)
  })
})

describe("a provider's models in Settings", () => {
  it('[UC-NOTICO-AGENT-002-S07] a search lists the matching models with their price; those without tools can not be switched on', async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.models.push(
      listed('google/gemma-5-27b', 'Google: Gemma 5 27B', 0.1, 0.4),
      { ...listed('google/gemma-5-9b', 'Google: Gemma 5 9B'), supported_parameters: ['temperature'] },
      listed('google/gemma-5-27b:batch', 'Google: Gemma 5 27B (batch)'),
      listed('~google/gemma-latest', 'Google: Gemma Latest'),
    )
    browser.openRouter.keys.add(KEY)
    await openSettings(user)
    await turnOn(user, 'OpenRouter', KEY)
    await user.type(
      provider('OpenRouter').getByRole('searchbox', { name: 'Find another model on OpenRouter' }),
      'gemma',
    )

    const results = within(provider('OpenRouter').getByRole('list', { name: 'Search results' })).getAllByRole('switch')
    expect(results.map((r) => r.getAttribute('aria-label'))).toEqual(['Google: Gemma 5 27B', 'Google: Gemma 5 9B'])
    expect(results[0]).toHaveAccessibleDescription('$0.10 in · $0.40 out per million tokens · 200K context')
    expect(results[1]).toBeDisabled()
    expect(results[1]).toHaveAccessibleDescription("Can't use tools, which Notico needs")

    await user.click(results[0])
    await user.clear(provider('OpenRouter').getByRole('searchbox', { name: 'Find another model on OpenRouter' }))
    // It joins the list, after the recommended ones, and the menu.
    const list = within(provider('OpenRouter').getByRole('list', { name: "OpenRouter's models" })).getAllByRole(
      'switch',
    )
    expect(list.at(-1)).toHaveAccessibleName('Google: Gemma 5 27B')
    expect(list.at(-1)).toBeChecked()
    await backToChat(user)
    await user.click(chip('Auto'))
    expect(menuItems()).toEqual(['Auto', 'Claude Sonnet 5.5', 'Gemma 5 27B'])
    await user.click(screen.getByRole('menuitemradio', { name: 'Gemma 5 27B' }))
    browser.openRouter.ai.script.push({ reply: 'From Gemma.' })
    await ask(user, 'Hello?')
    expect(await screen.findByText('From Gemma.')).toBeVisible()
    expect(browser.openRouter.calls.map((c) => c.model)).toEqual(['google/gemma-5-27b'])
  })

  it("[UC-NOTICO-AGENT-002-S20] the menu offers exactly the models that are on, and a provider's last one stays on", async () => {
    const { browser, user } = await openPanel()
    browser.openRouter.keys.add(KEY)
    await openSettings(user)
    await turnOn(user, 'OpenRouter', KEY)
    const sonnet = await waitFor(() => modelSwitch('OpenRouter', 'Anthropic: Claude Sonnet 5.5'))
    // The only model on can't be switched off.
    expect(sonnet).toBeChecked()
    expect(sonnet).toBeDisabled()

    await user.click(modelSwitch('OpenRouter', 'OpenAI: GPT-6 Luna'))
    await user.click(modelSwitch('OpenRouter', 'Anthropic: Claude Haiku 5.5'))
    expect(sonnet).toBeEnabled()
    await user.click(sonnet)
    expect(sonnet).not.toBeChecked()
    await backToChat(user)
    await user.click(chip('Auto'))
    // In the order of the list in Settings, the recommended ones first.
    expect(menuItems()).toEqual(['Auto', 'Claude Haiku 5.5', 'GPT-6 Luna'])
    await user.keyboard('{Escape}')

    await openSettings(user)
    await user.click(modelSwitch('OpenRouter', 'Anthropic: Claude Haiku 5.5'))
    expect(modelSwitch('OpenRouter', 'OpenAI: GPT-6 Luna')).toBeDisabled()
    await backToChat(user)
    await user.click(chip('Auto'))
    expect(menuItems()).toEqual(['Auto', 'GPT-6 Luna'])
  })

  it('[UC-NOTICO-AGENT-002-S21] a chosen model switched off in Settings moves the composer to Auto, which says so', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await openSettings(user)
    await user.click(modelSwitch('OpenRouter', 'OpenAI: GPT-6.1 Sol'))
    await backToChat(user)
    expect(chip('Auto')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'GPT-6.1 Sol was switched off in Settings, so questions use Auto.',
    )

    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.openRouter.calls).toEqual([])

    // Picking a model from the menu answers the note.
    await answered()
    await pick(user, 'Claude Sonnet 5.5')
    expect(screen.queryByText(/was switched off in Settings/)).not.toBeInTheDocument()
  })

  it('contacts OpenRouter only once it is on with a key, and its list without the key', async () => {
    const { browser, user } = await openPanel()
    await openSettings(user)
    await user.click(providerSwitch('OpenRouter'))
    await user.click(providerSwitch('DeepSeek'))
    expect(browser.openRouter.requests).toEqual([])
    expect(browser.deepSeek.requests).toEqual([])
    // Switched off before a key passed: nothing is saved.
    await user.click(providerSwitch('OpenRouter'))
    expect(provider('OpenRouter').queryByLabelText('OpenRouter API key')).not.toBeInTheDocument()
    expect(savedSettings(browser).key).toBeUndefined()
  })
})

describe('the model menu in the chat', () => {
  it('[UC-NOTICO-AGENT-002-S10] a follow-up goes to the model picked from the chat, with the conversation so far', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    browser.openRouter.ai.script.push({ reply: 'From Sol.' }, { reply: 'From Sonnet.' })
    await ask(user, 'First question')
    await screen.findByText('From Sol.')
    await answered()

    await user.click(chip('GPT-6.1 Sol'))
    const menu = screen.getByRole('menu', { name: 'Model' })
    expect(within(menu).getByRole('menuitemradio', { name: 'GPT-6.1 Sol' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Claude Sonnet 5.5' }))

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

  it('[UC-NOTICO-AGENT-002-S18] a question already running ends with the model it started with', async () => {
    const tab = pageTab()
    const { browser, user } = await openPanel(tab)
    await setUpOpenRouter(browser, user)
    await pick(user, 'Auto')
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] },
      { reply: 'From the hosted model.' },
    )
    // Notion holds its answer, so the question is still running when the user switches.
    const release = tab.hold('loadPageChunk')
    await ask(user, 'What does this page say?')
    await waitFor(() => expect(tab.sent).toHaveLength(1))

    await pick(user, 'GPT-6.1 Sol')
    expect(chip('GPT-6.1 Sol')).toBeVisible()
    release()
    expect(await screen.findByText('From the hosted model.')).toBeVisible()
    await answered()
    // Both of the question's model calls went to the hosted model.
    expect(browser.ai.calls).toHaveLength(2)
    expect(browser.openRouter.calls).toEqual([])

    browser.openRouter.ai.script.push({ reply: 'From Sol.' })
    await ask(user, 'A follow-up')
    expect(await screen.findByText('From Sol.')).toBeVisible()
    expect(browser.openRouter.calls.map((c) => c.model)).toEqual(['openai/gpt-6.1-sol'])
    expect(JSON.stringify(browser.openRouter.calls[0].messages)).toContain('From the hosted model.')
    expect(browser.ai.calls).toHaveLength(2)
  })

  it('[UC-NOTICO-AGENT-002-S17] Auto comes first, then each provider with its models by name, and Manage models opens Settings at Providers', async () => {
    const { browser, user } = await openPanel()
    await user.click(chip('Auto'))
    expect(menuItems()).toEqual(['Auto'])
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)
    await user.click(chip('DeepSeek V4.1 Flash'))
    const menu = within(screen.getByRole('menu', { name: 'Model' }))
    expect(menuItems()).toEqual(['Auto', 'Claude Sonnet 5.5', 'GPT-6.1 Sol', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Pro'])
    expect(within(menu.getByRole('group', { name: 'OpenRouter' })).getAllByRole('menuitemradio')).toHaveLength(2)
    expect(within(menu.getByRole('group', { name: 'DeepSeek' })).getAllByRole('menuitemradio')).toHaveLength(2)
    // Names only: no prices, nothing about who pays or the key.
    expect(screen.getByRole('menu', { name: 'Model' })).not.toHaveTextContent(/\$|credits|key/i)

    await user.click(menu.getByRole('menuitem', { name: 'Manage models' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Providers' })).toHaveFocus()
  })

  it('[UC-NOTICO-AGENT-002-S12] switching between OpenRouter and DeepSeek in the composer uses each with its own key, never asked again', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)
    browser.deepSeek.ai.script.push({ reply: 'From DeepSeek.' }, { reply: 'DeepSeek again.' })
    browser.openRouter.ai.script.push({ reply: 'From Sol.' })

    await ask(user, 'First question')
    expect(await screen.findByText('From DeepSeek.')).toBeVisible()
    await answered()

    await pick(user, 'GPT-6.1 Sol')
    await ask(user, 'Second question')
    expect(await screen.findByText('From Sol.')).toBeVisible()
    await answered()

    await pick(user, 'DeepSeek V4.1 Flash')
    await ask(user, 'Third question')
    expect(await screen.findByText('DeepSeek again.')).toBeVisible()

    expect(browser.deepSeek.calls.map((c) => c.key)).toEqual([DS_KEY, DS_KEY])
    expect(browser.openRouter.calls.map((c) => c.key)).toEqual([KEY])
    // The follow-ups went on with the conversation so far.
    expect(JSON.stringify(browser.deepSeek.calls[1].messages)).toContain('From Sol.')
    // Neither key went to the other provider.
    expect(browser.deepSeek.requests.every((r) => r.key === DS_KEY)).toBe(true)
    expect(browser.openRouter.requests.every((r) => r.key === undefined || r.key === KEY)).toBe(true)
    expect(browser.ai.calls).toEqual([])
  })

  it('works from the keyboard: the arrows move through it, and Escape closes it on the button', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await user.click(chip('GPT-6.1 Sol'))
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: 'Claude Sonnet 5.5' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Manage models' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Model' })).not.toBeInTheDocument()
    expect(chip('GPT-6.1 Sol')).toHaveFocus()
  })
})

describe('DeepSeek with the user key', () => {
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
    expect(await screen.findByText(/DeepSeek turned your key away. Check it in Settings./)).toBeVisible()
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-NOTICO-AGENT-002-S15] when DeepSeek turns requests away for too many, the question stops and nothing is sent again', async () => {
    const { browser, user } = await openPanel()
    await setUpDeepSeek(browser, user)
    browser.deepSeek.rateLimited = true
    const before = browser.deepSeek.requests.length

    await ask(user, 'Hello?')
    expect(await screen.findByText(/DeepSeek is getting too many requests .* Wait a minute/)).toBeVisible()
    await answered()
    expect(browser.deepSeek.requests).toHaveLength(before + 1)
    expect(browser.ai.calls).toEqual([])
  })

  it("removing the DeepSeek key keeps OpenRouter's", async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    await setUpDeepSeek(browser, user)

    await openSettings(user)
    await user.click(provider('DeepSeek').getByRole('button', { name: 'Remove key' }))
    expect(JSON.stringify(browser.tab.storage.values)).not.toContain(DS_KEY)
    expect(provider('OpenRouter').getByText(/^Key works/)).toBeVisible()
    await backToChat(user)
    // The model chosen was DeepSeek's: Auto answers now, and the composer says so.
    expect(chip('Auto')).toBeVisible()
    await pick(user, 'GPT-6.1 Sol')
    expect(chip('GPT-6.1 Sol')).toBeVisible()
  })
})
