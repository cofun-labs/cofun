import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser } from './panel'
import { pageTab } from './tab'

afterEach(closeBrowser)

async function openPanel() {
  const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
/** The conversation, without the header above it, which also shows the first question. */
const conversation = () => within(screen.getByRole('main'))

async function ask(user: UserEvent, question: string) {
  await user.click(composer())
  await user.paste(question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** The question has ended: the composer offers Send again. */
const answered = () => screen.findByRole('button', { name: 'Send' })

/**
 * A model reply that stops partway until `resume` is called. The fake model streams each word as an
 * event of about 60 bytes, so it stops after the first two words.
 */
function pausedReply(browser: FakeBrowser, reply: string, after = 150) {
  let resume!: () => void
  browser.ai.pause = { after, until: new Promise<void>((resolve) => (resume = resolve)) }
  browser.ai.script.push({ reply })
  return resume
}

const comesBefore = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('asking the AI', () => {
  it('[UC-CONFLUCO-CHAT-001-S03] the sent message appears and the reply streams in below it', async () => {
    const { browser, user } = await openPanel()
    // The model has written its first words and is still writing.
    const resume = pausedReply(browser, 'The roadmap has three milestones')

    await ask(user, 'What is on the roadmap?')

    const question = await conversation().findByText('What is on the roadmap?')
    const reply = await screen.findByText(/^The roadmap/)
    expect(reply).not.toHaveTextContent('milestones')
    expect(comesBefore(question, reply)).toBe(true)
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()

    resume()
    expect(await screen.findByText('The roadmap has three milestones')).toBeVisible()
    await answered()
  })

  it('[UC-CONFLUCO-AUTH-001-S01] the signed-in account can use chat and credits on the shared Worker', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Hello.' })

    await ask(user, 'Hi')

    expect(await screen.findByText('Hello.')).toBeVisible()
    await answered()
    await user.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('menuitem', { name: /^Credits, [\d.]+ left$/ })).toBeVisible()
    // The reply, and the chat's title if the panel has asked for it yet: each under Confluco.
    const products = browser.db.calls().map((call) => call.product)
    expect(products.length).toBeGreaterThan(0)
    expect(products.every((product) => product === 'confluco')).toBe(true)
  })

  it('[UC-CONFLUCO-CHAT-001-S04] stops a reply that is still streaming', async () => {
    const { browser, user } = await openPanel()
    const resume = pausedReply(browser, 'The roadmap has three milestones')
    await ask(user, 'What is on the roadmap?')
    await screen.findByText(/^The roadmap/)
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText('Stopped')).toBeVisible()
    await answered()
    resume()
    expect(screen.queryByText('The roadmap has three milestones')).not.toBeInTheDocument()
  })
})

describe('sessions', () => {
  it.each([false, true])(
    '[UC-CONFLUCO-SESSION-001-S01][UC-CONFLUCO-SESSION-001-S06] a follow-up retains the earlier tools with reopen=%s',
    async (reopen) => {
      const { browser, user } = await openPanel()
      browser.ai.script.push(
        { toolCalls: [{ name: 'get_current_tab', arguments: '{}' }] },
        { reply: 'It is a fixture.' },
      )
      await ask(user, 'Which page am I on?')
      await screen.findByText('It is a fixture.')
      await answered()

      if (reopen) {
        await browser.openPanel()
        expect(conversation().queryByText('Which page am I on?')).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Chats' }))
        await user.click(await screen.findByRole('button', { name: /^Which page am I on/ }))
      }
      expect(await conversation().findByText('Which page am I on?')).toBeVisible()
      expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()

      browser.ai.script.push({ reply: 'Its title is Fixture page.' })
      await ask(user, 'What is its title?')
      await screen.findByText('Its title is Fixture page.')
      await answered()

      expect(browser.sentToModel()).toMatchObject([
        { role: 'system' },
        { role: 'user', content: 'Which page am I on?' },
        { role: 'assistant', tool_calls: [{ function: { name: 'get_current_tab' } }] },
        { role: 'tool', content: expect.stringContaining('Fixture page') },
        { role: 'assistant', content: expect.stringContaining('It is a fixture.') },
        { role: 'user', content: 'What is its title?' },
      ])
    },
  )
})
describe('signing in and out', () => {
  it('[UC-CONFLUCO-AUTH-001-S04] signing out from the side panel returns it to the sign-in screen', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('Sign in to use Confluco.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    // The chat is gone: nothing to type into, and the conversation is off the screen.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText('Three milestones.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
  })

  it('[@no-uc:access] a signed-out panel offers only to sign in, on the sign-in page', async () => {
    const browser = await FakeBrowser.start(pageTab())
    await browser.openPanel()
    const user = userEvent.setup()

    expect(screen.getByText('Sign in to use Confluco.')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(browser.openedTabs).toEqual(['https://copilot.test/login?app=confluco'])
    expect(browser.ai.calls).toEqual([])
  })
})
