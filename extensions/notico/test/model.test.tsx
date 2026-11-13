// Choosing which model answers (UC-AGENT-002), as a user does it on the settings page. Besides the
// screen, the tests look at the edges: what OpenRouter and the worker were sent.
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

describe('choosing the model', () => {
  it('[UC-AGENT-002-S01] the own model answers with the user key and a tool, and the worker never gets the key or the question', async () => {
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

  it('[UC-AGENT-002-S02] another account on the same browser gets the hosted model and cannot see the key', async () => {
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
    expect(modelInUse()).toHaveTextContent('Notico (hosted)')
    await user.click(screen.getByRole('radio', { name: 'OpenRouter, with your key' }))
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    expect(screen.queryByText(/key is saved/)).not.toBeInTheDocument()
  })

  it('[UC-AGENT-002-S03] a key OpenRouter rejects is reported as rejected', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)
    // The key was revoked on OpenRouter since.
    browser.openRouter.keys.clear()

    await ask(user, 'Hello?')
    expect(await screen.findByText(/OpenRouter rejected your key/)).toBeVisible()
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-AGENT-002-S04] after the key is removed, the hosted model answers', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove key' }))
    expect(modelInUse()).toHaveTextContent('Notico (hosted)')
    await backToChat(user)

    await ask(user, 'Hello?')
    expect(await screen.findByText(/Hello from Workers AI/)).toBeVisible()
    expect(browser.openRouter.calls).toEqual([])
  })

  it('[UC-AGENT-002-S05] switching from the hosted model mid-conversation, the own model gets the conversation so far', async () => {
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

  it('[UC-AGENT-002-S06] the own model still answers after the side panel is opened again', async () => {
    const { browser, user } = await openPanel()
    await setUpOpenRouter(browser, user)

    await browser.openPanel()
    browser.openRouter.ai.script.push({ reply: 'Still mine.' })
    await ask(user, 'Hello?')
    expect(await screen.findByText('Still mine.')).toBeVisible()
    expect(browser.openRouter.calls.map((c) => c.key)).toEqual([KEY])
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-AGENT-002-S07] a search shows only models that can use tools, with their price, and one can be picked', async () => {
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

  it('[UC-AGENT-002-S08] checking a key and model says whether the model answered and can use tools', async () => {
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
    expect(modelInUse()).toHaveTextContent('Notico (hosted)')
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
