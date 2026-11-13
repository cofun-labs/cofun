// The history of the user's credits, opened from the settings page, tested as a user meets it: the
// whole panel runs (see panel.ts) against the real worker, and the tests only type, click, and read
// what is on screen.
// The tests' clock is 5:30 ahead of UTC (vitest.config.ts): 12:00 UTC, when a test starts, is 5:30 PM.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageCosting } from '../../../worker/test/fakes'
import { pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DOWN = new Error('D1_ERROR: Network connection lost.')
/** What only the worker's read of a page of grants, or of a period of usage, contains. */
const GRANTS_READ = 'ORDER BY granted_at DESC'
const USAGE_READ = 'max(started_at)'

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

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}

/** Opens the credit history from the settings page's credits. */
async function openHistory(user: UserEvent) {
  await openSettings(user)
  await user.click(within(section('Credits')).getByRole('button', { name: 'Credit history' }))
  expect(screen.getByRole('heading', { name: 'Credit history' })).toBeVisible()
}

/** A section of the page, by its heading. */
const section = (name: string) => screen.getByRole('region', { name })

/** The lots of credits the history lists, once it has loaded some: the text of each. */
async function lots() {
  const list = await within(section('Credits you were given')).findByRole('list')
  return within(list)
    .getAllByRole('listitem')
    .map((lot) => lot.textContent)
}

/** How many credits each lot was. */
const amounts = (lots: string[]) => lots.map((lot) => /credits(\d+ credits?)Given/.exec(lot)?.[1])

/** The rows of a usage table: each day and the credits used on it. */
const usageRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .map((row) => [within(row).getByRole('rowheader').textContent, within(row).getByRole('cell').textContent])

describe('the credit history', () => {
  it('[UC-CHAT-003-S10] lists every lot of credits the user was given, newest first, with its dates and what went unspent', async () => {
    const { browser, user } = await openPanel()
    // Week one: 60 of the free credits are used, and 140 expire unspent.
    await ask(browser, user, 'First', 60)
    // Week two: new free credits, and an hour later 100 credits added by hand, for 30 days.
    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await ask(browser, user, 'Second', 30)
    vi.setSystemTime(START.getTime() + 7 * DAY_MS + HOUR_MS)
    await browser.grantCredits('user_alice', 100, 30)
    // Week three: the second week has ended too.
    vi.setSystemTime(START.getTime() + 14 * DAY_MS + HOUR_MS)

    await openHistory(user)

    expect(await lots()).toEqual([
      'Added credits100 creditsGiven Nov 15, 2026 · 100 left, expire Dec 15, 2026',
      'Free weekly credits200 creditsGiven Nov 15, 2026 · expired Nov 22, 2026 with 170 credits unspent',
      'Free weekly credits200 creditsGiven Nov 8, 2026 · expired Nov 15, 2026 with 140 credits unspent',
    ])
    // The settings page itself shows only the credits that still count.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    const current = within(section('Credits')).getByRole('list', { name: 'Your credits' })
    expect(within(current).getAllByRole('listitem')[0]).toHaveTextContent('Added credits100 left')
  })

  it('[UC-CHAT-003-S10] shows credits that were used to the end, before and after they expire', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 210)

    await openHistory(user)
    expect(await lots()).toEqual(['Free weekly credits200 creditsGiven Nov 8, 2026 · used up, until Nov 15, 2026'])

    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Credit history' }))
    expect(await lots()).toEqual(['Free weekly credits200 creditsGiven Nov 8, 2026 · expired Nov 15, 2026'])
  })

  it('[UC-CHAT-003-S10] shows the newest lots first, and older ones when asked, to the end', async () => {
    const { browser, user } = await openPanel()
    // 25 lots, told apart by how many credits each was.
    for (let credits = 1; credits <= 25; credits++) {
      await browser.grantCredits('user_alice', credits, 30)
      vi.setSystemTime(START.getTime() + credits * HOUR_MS)
    }

    await openHistory(user)

    expect(amounts(await lots())).toEqual(Array.from({ length: 20 }, (_, i) => `${25 - i} credits`))
    await user.click(screen.getByRole('button', { name: 'Show older credits' }))
    expect(await screen.findByText('1 credit')).toBeVisible()
    expect(amounts(await lots())).toEqual([...Array.from({ length: 24 }, (_, i) => `${25 - i} credits`), '1 credit'])
    // That was the last of them.
    expect(screen.queryByRole('button', { name: 'Show older credits' })).not.toBeInTheDocument()
  })

  it('[UC-CHAT-003-S11] shows the credits used per day further back than the settings page, by the days of the user’s own clock', async () => {
    const { browser, user } = await openPanel()
    // 11:30 PM on Nov 8, on the user's clock.
    vi.setSystemTime(new Date('2026-11-08T18:00:00Z'))
    await ask(browser, user, 'First', 30)
    // 12:30 AM on Nov 9 on the user's clock, though still Nov 8 in UTC.
    vi.setSystemTime(new Date('2026-11-08T19:00:00Z'))
    await ask(browser, user, 'Second', 60)
    // Months later.
    vi.setSystemTime(new Date('2027-02-01T12:00:00Z'))
    await ask(browser, user, 'Third', 6)
    vi.setSystemTime(new Date('2027-02-03T12:00:00Z'))

    await openSettings(user)
    // The settings page reaches back 30 days.
    const recent = await within(section('Usage')).findByRole('table', { name: 'Credits used per day, last 30 days' })
    expect(usageRows(recent)).toEqual([['Mon, Feb 1', '6']])

    await user.click(screen.getByRole('button', { name: 'Credit history' }))
    const usage = within(section('Usage'))
    expect(usageRows(await usage.findByRole('table', { name: 'Credits used per day since Jan 5, 2027' }))).toEqual([
      ['Mon, Feb 1, 2027', '6'],
    ])

    // Further back: the weeks without a question are skipped.
    await user.click(usage.getByRole('button', { name: 'Show earlier usage' }))
    expect(usageRows(await usage.findByRole('table', { name: 'Credits used per day since Oct 11, 2026' }))).toEqual([
      ['Mon, Feb 1, 2027', '6'],
      ['Mon, Nov 9, 2026', '60'],
      ['Sun, Nov 8, 2026', '30'],
    ])
    // Nothing was used before that.
    expect(usage.queryByRole('button', { name: 'Show earlier usage' })).not.toBeInTheDocument()
  })

  it('tells a user who was given nothing and used nothing so, and opening it does not start their free credits', async () => {
    const { user } = await openPanel()

    await openHistory(user)

    expect(
      await within(section('Credits you were given')).findByText(
        'No credits yet. Your free credits start with your next question.',
      ),
    ).toBeVisible()
    expect(await within(section('Usage')).findByText('No credits used yet.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(
      await within(section('Credits')).findByText('Your free credits start with your next question.'),
    ).toBeVisible()
  })

  it('when the history cannot be read, it says so and offers to try again, and the settings page and the chat still work', async () => {
    const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
    // Only the reads of the history fail.
    browser.db.failOn = { sql: GRANTS_READ, error: DOWN }
    await browser.openPanel()
    const user = userEvent.setup()
    await ask(browser, user, 'What is on the roadmap?', 60)

    await openSettings(user)
    expect(await within(section('Credits')).findByText('140 credits left')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Credit history' }))

    const given = within(section('Credits you were given'))
    expect(await given.findByRole('alert')).toHaveTextContent('Your credits could not be loaded.')
    // The usage is read apart from the grants, and shows.
    expect(await within(section('Usage')).findByRole('table')).toBeVisible()

    // Once the worker can read them again, trying again shows them.
    browser.db.failOn = undefined
    await user.click(given.getByRole('button', { name: 'Try again' }))
    expect(await lots()).toEqual(['Free weekly credits200 creditsGiven Nov 8, 2026 · 140 left, expire Nov 15, 2026'])
    expect(given.queryByRole('alert')).not.toBeInTheDocument()

    // The usage failing leaves the grants, the settings page, and the chat as they are.
    browser.db.failOn = { sql: USAGE_READ, error: DOWN }
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Credit history' }))
    expect(await within(section('Usage')).findByRole('alert')).toHaveTextContent('Your usage could not be loaded.')
    expect(await lots()).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(await within(section('Credits')).findByText('140 credits left')).toBeVisible()
    await user.keyboard('{Escape}')
    await ask(browser, user, 'Who owns the launch?', 30)
  })

  it('when older lots cannot be read, the ones already shown stay, and trying again adds the rest', async () => {
    const { browser, user } = await openPanel()
    for (let credits = 1; credits <= 25; credits++) await browser.grantCredits('user_alice', credits, 30)
    await openHistory(user)
    expect(await lots()).toHaveLength(20)

    browser.db.failOn = { sql: GRANTS_READ, error: DOWN }
    await user.click(screen.getByRole('button', { name: 'Show older credits' }))
    const given = within(section('Credits you were given'))
    expect(await given.findByRole('alert')).toHaveTextContent('Your credits could not be loaded.')
    expect(await lots()).toHaveLength(20)

    browser.db.failOn = undefined
    await user.click(given.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1 credit')).toBeVisible()
    expect(await lots()).toHaveLength(25)
  })

  it('works with the keyboard: it opens from the settings page, and Escape leads back a step at a time', async () => {
    const { user } = await openPanel()
    await openSettings(user)

    screen.getByRole('button', { name: 'Credit history' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Credit history' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()

    // Escape leads back to the settings page, with the focus on what opened the history.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Credit history' })).toHaveFocus()

    // Back does the same, and from the settings page it leads to the chat.
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  })
})
