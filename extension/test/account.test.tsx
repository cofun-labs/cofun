// The account menu and the settings page, tested as a user meets them: the whole panel runs (see
// panel.ts) against the real worker, and the tests only type, click, and read what is on screen.
// The tests' clock is 5:30 ahead of UTC (vitest.config.ts): 12:00 UTC, when a test starts, is 5:30 PM.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageCosting } from '../../worker/test/fakes'
import { pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

const DAY_MS = 24 * 60 * 60 * 1000

/** A browser signed in to Notico, with the side panel open. */
async function openPanel() {
  const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

/** Asks a question whose reply costs `credits` (a multiple of 3), and waits for it to end. */
async function ask(browser: FakeBrowser, user: UserEvent, question: string, credits: number) {
  browser.ai.usage = usageCosting(credits)
  browser.ai.script.push({ reply: `Answer to: ${question}` })
  await user.type(screen.getByRole('textbox', { name: 'Message' }), `${question}{Enter}`)
  await screen.findByText(`Answer to: ${question}`)
  await screen.findByRole('button', { name: 'Send' })
}

const accountButton = () => screen.getByRole('button', { name: 'Account' })

/** Opens the account menu, once the credits in it have loaded. */
async function openMenu(user: UserEvent) {
  await user.click(accountButton())
  expect(await screen.findByRole('menu', { name: 'Account' })).toBeVisible()
}

async function openSettings(user: UserEvent) {
  await openMenu(user)
  await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}

/** A section of the settings page, by its heading. */
const section = (name: string) => screen.getByRole('region', { name })

describe('the account menu', () => {
  it('[UC-CHAT-003-S09] shows who is signed in, with Settings and Sign out, and nothing to manage the account', async () => {
    const { user } = await openPanel()

    await openMenu(user)

    expect(screen.getByText('Alice Example')).toBeVisible()
    expect(screen.getByText('alice@example.com')).toBeVisible()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Settings', 'Sign out'])
    expect(screen.queryByText(/manage account/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/clerk/i)).not.toBeInTheDocument()
  })

  it('[UC-CHAT-003-S01] shows the credits that are left and when they expire', async () => {
    const { browser, user } = await openPanel()

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)

    expect(await screen.findByText('140 credits left')).toBeVisible()
    // The week started with the question, at 5:30 PM on Nov 8.
    expect(screen.getByText('Expire Nov 15, 5:30 PM')).toBeVisible()
  })

  it('[UC-CHAT-003-S06] shows what is left after each question, without the panel being opened again', async () => {
    const { browser, user } = await openPanel()
    await openMenu(user)
    expect(await screen.findByText('200 credits left')).toBeVisible()
    await user.keyboard('{Escape}')

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)
    expect(await screen.findByText('140 credits left')).toBeVisible()
    await user.keyboard('{Escape}')

    await ask(browser, user, 'Who owns the launch?', 30)
    await openMenu(user)
    expect(await screen.findByText('110 credits left')).toBeVisible()
  })

  it('[UC-CHAT-003-S02] shows a new user the free credits their next question starts with, and looking does not start the week', async () => {
    const { browser, user } = await openPanel()

    await openMenu(user)

    expect(await screen.findByText('200 credits left')).toBeVisible()
    expect(screen.getByText('Valid for 7 days from your next question')).toBeVisible()
    await user.keyboard('{Escape}')

    // Two days later the first question starts the week: 200 credits, less what it cost, for 7 days from now.
    vi.setSystemTime(START.getTime() + 2 * DAY_MS)
    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)
    expect(await screen.findByText('140 credits left')).toBeVisible()
    expect(screen.getByText('Expire Nov 17, 5:30 PM')).toBeVisible()
  })

  it('[UC-CHAT-003-S03] shows a user who overspent that no credits are left, and then the next free credits less what they owe', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 150)
    // 50 credits are left: the question goes ahead, and overspends by 100.
    await ask(browser, user, 'Second', 150)

    await openMenu(user)
    expect(await screen.findByText('No credits left')).toBeVisible()
    expect(screen.getByText('Free credits arrive with your first question after Nov 15, 5:30 PM')).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(
      await within(section('Credits')).findByText(
        'You overspent 100 credits. They come out of the next credits you get.',
      ),
    ).toBeVisible()

    // The week has ended: the panel is opened again.
    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await browser.openPanel()
    await openMenu(user)
    expect(await screen.findByText('100 credits left')).toBeVisible()
    expect(screen.getByText('Valid for 7 days from your next question')).toBeVisible()
  })

  it('works with the keyboard', async () => {
    const { user } = await openPanel()
    accountButton().focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()

    // Escape closes the menu and gives the focus back to the avatar.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(accountButton()).toHaveFocus()
    expect(accountButton()).toHaveAttribute('aria-expanded', 'false')

    // Settings opens from the keyboard, and Escape leads back to the chat, with the focus on the avatar again.
    await user.keyboard('{Enter}{Enter}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(accountButton()).toHaveFocus()
  })

  it('closes when the user clicks elsewhere', async () => {
    const { user } = await openPanel()
    await openMenu(user)

    await user.click(screen.getByRole('textbox', { name: 'Message' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('the settings page', () => {
  it('[UC-CHAT-003-S09] shows the account and the plan', async () => {
    const { user } = await openPanel()

    await openSettings(user)

    expect(within(section('Account')).getByText('Alice Example')).toBeVisible()
    expect(within(section('Account')).getByText('alice@example.com')).toBeVisible()
    expect(within(section('Plan')).getByText('Free')).toBeVisible()

    // Back leads to the chat.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  })

  it('[UC-CHAT-003-S01] shows what is left, when it expires, and when the next free credits arrive', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'What is on the roadmap?', 60)

    await openSettings(user)

    const credits = within(section('Credits'))
    expect(await credits.findByText('140 credits left')).toBeVisible()
    const lots = within(credits.getByRole('list', { name: 'Your credits' })).getAllByRole('listitem')
    expect(lots.map((lot) => lot.textContent)).toEqual(['Free weekly credits140 left, expire Nov 15, 5:30 PM'])
    expect(
      credits.getByText('Your next free credits arrive with your first question after Nov 15, 5:30 PM.'),
    ).toBeVisible()
  })

  it('[UC-CHAT-003-S02] shows free credits that have not started as such', async () => {
    const { user } = await openPanel()

    await openSettings(user)

    const credits = within(section('Credits'))
    expect(await credits.findByText('200 credits left')).toBeVisible()
    const lots = within(credits.getByRole('list', { name: 'Your credits' })).getAllByRole('listitem')
    expect(lots.map((lot) => lot.textContent)).toEqual([
      'Free weekly credits200, not started: valid for 7 days from your next question',
    ])
    expect(credits.getByText('Your free credits start with your next question.')).toBeVisible()
    expect(within(section('Usage')).getByText('No credits used in the last 30 days.')).toBeVisible()
  })

  it('[UC-CHAT-003-S04] lists the credits used on each day, newest first, by the days of the user’s own clock', async () => {
    const { browser, user } = await openPanel()
    // 5:30 PM on Nov 8, on the user's clock.
    await ask(browser, user, 'First', 30)
    // 12:30 AM on Nov 9 on the user's clock, though still Nov 8 in UTC.
    vi.setSystemTime(new Date('2026-11-08T19:00:00Z'))
    await ask(browser, user, 'Second', 60)
    await ask(browser, user, 'Third', 6)

    await openSettings(user)

    const usage = await within(section('Usage')).findByRole('table', { name: 'Credits used per day, last 30 days' })
    expect(
      within(usage)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Mon, Nov 966', 'Sun, Nov 830'])
  })

  it('[UC-CHAT-003-S08] when credits cannot be read, the user can still ask, and the panel says credits are unavailable', async () => {
    const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
    // Only reading the usage fails; the worker can still check and charge credits for a question.
    browser.db.failOn = { sql: 'GROUP BY day', error: new Error('D1_ERROR: Network connection lost.') }
    await browser.openPanel()
    const user = userEvent.setup()

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)
    expect(await screen.findByText('Credits unavailable')).toBeVisible()
    expect(screen.queryByText(/credits left/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    const credits = within(section('Credits'))
    expect(await credits.findByRole('alert')).toHaveTextContent(
      'Your credits could not be loaded. You can still ask questions.',
    )

    // Once the worker can read them again, trying again shows them.
    browser.db.failOn = undefined
    await user.click(credits.getByRole('button', { name: 'Try again' }))
    expect(await credits.findByText('140 credits left')).toBeVisible()
  })
})

describe('a question refused for lack of credits', () => {
  it('[UC-CHAT-003-S07] says when credits arrive and leads to the settings page', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 210)

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Second{Enter}')

    expect(
      await screen.findByText(
        /You have no credits left\. Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC\./,
      ),
    ).toBeVisible()
    expect(browser.ai.calls).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'See your credits' }))

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(await within(section('Credits')).findByText('No credits left')).toBeVisible()
  })
})
