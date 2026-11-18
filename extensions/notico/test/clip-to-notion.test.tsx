// Clipping a page, or the text selected on it, to a Notion page chosen in Settings
// (UC-NOTICO-SESSION-003), as a user does it from the context menu: the service worker and the side
// panel both run, with Chrome's menu, tabs, and storage faked. The fake workspace applies what the
// clip writes, so it is read back from there.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIP_PAGE, CLIP_SELECTION } from '../src/clip'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, webPage } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const ARTICLE = 'https://news.example.com/2026/rivers?ref=home'
const hex = (id: string) => id.replaceAll('-', '')
/** The chosen page's link, as Settings keeps it. */
const TARGET_URL = `https://app.notion.com/p/${hex(PAGE)}`
const OTHER = '4e4e4e4e-0000-4000-8000-000000000041'

type Run = [string, [string, unknown?][]?]
const runs = (b: object) =>
  ('properties' in b ? (b.properties as { title?: Run[] } | undefined)?.title : undefined) ?? []
const plain = (b: object) =>
  runs(b)
    .map((r) => r[0])
    .join('')

/**
 * A browser on an article, on a site Notico was never allowed to read, with a Notion workspace
 * holding the page "Inbox", chosen in Settings unless `target` says otherwise.
 */
async function start({ target = { url: TARGET_URL, title: 'Inbox' } as { url: string; title: string } | null } = {}) {
  const workspace = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      { id: PAGE, type: 'page', properties: { title: [['Inbox']] }, parent_id: SPACE, parent_table: 'space' },
    ],
    SPACE,
  )
  const tab = new FakeNotionTab(ARTICLE)
  tab.workspace = workspace
  tab.title = 'Rivers | News'
  tab.dom = webPage({
    title: 'Rivers | News',
    html: '<main><h2>Rivers</h2><p>Rivers are <strong>rising</strong>.</p></main>',
    url: ARTICLE,
  })
  if (target) tab.storage.syncValues.clipTarget = target
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.startServiceWorker()
  await browser.openPanel()
  return { browser, tab, workspace, user: userEvent.setup() }
}

/** Waits until the clip has ended, and returns what the panel says about it. */
async function clipped(): Promise<HTMLElement> {
  return screen.findByText(/^(Clipped to|Couldn't|Nothing was|The Notion account|Notion )/, {}, { timeout: 3000 })
}

const transactions = (workspace: FakeWorkspace) => workspace.transactions.length

describe('UC-NOTICO-SESSION-003 clip a page or a selection to Notion', () => {
  it('[UC-NOTICO-SESSION-003-S01] a page is clipped as a new page at the end of the chosen page, and nothing goes to the AI', async () => {
    const { browser, tab, workspace } = await start()
    expect(tab.menuItems.get(CLIP_PAGE)).toEqual({
      title: 'Clip page to Notion',
      contexts: ['page'],
      documentUrlPatterns: ['https://*/*', 'http://*/*', 'file:///*'],
      visible: true,
    })
    const toWorker = browser.sentToWorker.length

    tab.pickMenuItem(CLIP_PAGE, '')
    expect(tab.panelOpens).toEqual([1])

    await clipped()
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('Clipped to “Inbox”.')
    // The chosen page was shown in a new tab, which is the current one now.
    expect(browser.openedTabs).toEqual([TARGET_URL])
    expect(tab.url).toBe(TARGET_URL)

    const page = workspace.content(PAGE).at(-1)!
    expect(page.type).toBe('page')
    expect(plain(page)).toBe('Rivers | News')
    const blocks = workspace.content(page.id)
    expect(blocks.map((b) => [b.type, plain(b)])).toEqual([
      ['text', 'From Rivers | News'],
      ['sub_header', 'Rivers'],
      ['text', 'Rivers are rising.'],
    ])
    expect(runs(blocks[0])[1]).toEqual([
      'Rivers | News',
      [
        ['h', 'gray'],
        ['a', ARTICLE],
      ],
    ])
    expect(runs(blocks[2])).toContainEqual(['rising', [['b']]])
    expect(within(notice).getByRole('link', { name: 'Open the clipped page' })).toHaveAttribute(
      'href',
      `https://app.notion.com/p/${hex(page.id)}`,
    )
    // One write, and nothing to the model or the worker; the site was never asked about.
    expect(transactions(workspace)).toBe(1)
    expect(browser.ai.calls).toEqual([])
    expect(browser.sentToWorker.slice(toWorker)).toEqual([])
    expect(tab.accessRequests).toEqual([])
  })

  it('[UC-NOTICO-SESSION-003-S02] a selection is added at the end of the chosen page as a quote, in the tab already showing it', async () => {
    const { browser, tab, workspace } = await start()
    tab.otherTabs = [{ url: PAGE_URL, title: 'Inbox' }]
    expect(tab.menuItems.get(CLIP_SELECTION)).toMatchObject({ contexts: ['selection'], visible: true })

    tab.pickMenuItem(CLIP_SELECTION, 'Rivers are rising.\n**Not bold**\nThe city has a plan.')

    expect(await clipped()).toHaveTextContent('Clipped to “Inbox”.')
    expect(browser.openedTabs).toEqual([])
    expect(tab.url).toBe(PAGE_URL)
    const [quote, from] = workspace.content(PAGE).slice(-2)
    // Line breaks kept, and the page's words taken as they are, not as Markdown.
    expect([quote.type, plain(quote)]).toEqual(['quote', 'Rivers are rising.\n**Not bold**\nThe city has a plan.'])
    expect(runs(from)).toEqual([
      ['From ', [['h', 'gray']]],
      [
        'Rivers | News',
        [
          ['h', 'gray'],
          ['a', ARTICLE],
        ],
      ],
    ])
    expect(screen.getByRole('link', { name: 'Open the page' })).toHaveAttribute('href', TARGET_URL)
  })

  it("[UC-NOTICO-SESSION-003-S03] when the Notion account can't see the chosen page, nothing is written", async () => {
    const { tab, workspace } = await start({
      target: { url: `https://app.notion.com/p/${hex(OTHER)}`, title: 'Team inbox' },
    })

    tab.pickMenuItem(CLIP_PAGE, '')

    await clipped()
    expect(screen.getByRole('alert')).toHaveTextContent(
      "The Notion account signed in can't see “Team inbox”, the page clips go to. Switch to a Notion account that can, or choose another page in Settings.",
    )
    expect(transactions(workspace)).toBe(0)
  })

  it('[UC-NOTICO-SESSION-003-S04] a clip Notion turns away is not retried, and the user is told to wait', async () => {
    const { tab, workspace } = await start()
    tab.limit('saveTransactionsFanout', 1, 429, '30')

    tab.pickMenuItem(CLIP_SELECTION, 'Rivers are rising.')

    await clipped()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Notion is turning requests away right now (too many requests, or too busy), so nothing was clipped. Wait 30 seconds, then try again.',
    )
    expect(tab.sent.filter((r) => r.url.endsWith('/saveTransactionsFanout'))).toHaveLength(1)
    expect(workspace.content(PAGE)).toEqual([])
  })

  it('[UC-NOTICO-SESSION-003-S04] a clip Notion does not confirm is not retried, and the user is told to check', async () => {
    const { tab, workspace } = await start()
    workspace.failAfterApply = true

    tab.pickMenuItem(CLIP_SELECTION, 'Rivers are rising.')

    await clipped()
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Notion didn't say whether the clip was written. Look at the end of “Inbox” before clipping again.",
    )
    expect(tab.sent.filter((r) => r.url.endsWith('/saveTransactionsFanout'))).toHaveLength(1)
    expect(workspace.content(PAGE).map((b) => b.type)).toEqual(['quote', 'text'])
  })

  it('[UC-NOTICO-SESSION-003-S05] choosing the current Notion page in Settings shows the clip items, and turning Clip off hides them', async () => {
    const { tab, user } = await start({ target: null })
    // No page chosen: the items don't show.
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(false)
    expect(tab.menuItems.get(CLIP_SELECTION)?.visible).toBe(false)
    await openSettings(user)
    const clip = within(screen.getByRole('region', { name: 'Clip to Notion' }))
    expect(clip.getByText('No page chosen. Open a Notion page, then choose it.')).toBeVisible()
    expect(clip.queryByRole('switch')).toBeNull()

    // Off Notion, it says what to do.
    await user.click(clip.getByRole('button', { name: 'Use current page' }))
    expect(clip.getByRole('alert')).toHaveTextContent(
      'Open the Notion page to clip into in the current tab, then choose it here.',
    )

    tab.switchTab(PAGE_URL, 'Inbox')
    await user.click(clip.getByRole('button', { name: 'Use current page' }))
    expect(await clip.findByRole('link', { name: 'Inbox' })).toHaveAttribute('href', TARGET_URL)
    expect(clip.queryByRole('alert')).toBeNull()
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(true)
    expect(tab.menuItems.get(CLIP_SELECTION)?.visible).toBe(true)

    await user.click(clip.getByRole('switch', { name: 'Show “Clip” in the right-click menu' }))
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(false)
    expect(tab.menuItems.get(CLIP_SELECTION)?.visible).toBe(false)
  })
})

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}
