// Clipping a page to a Notion page chosen in Settings
// (UC-NOTICO-SESSION-003), as a user does it from the context menu: the service worker and the side
// panel both run, with Chrome's menu, tabs, and storage faked. The fake workspace applies what the
// clip writes, so it is read back from there.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIP_PAGE } from '../src/clip'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, webPage } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const ARTICLE = 'https://news.example.com/2026/rivers?ref=home'
const hex = (id: string) => id.replaceAll('-', '')
/** The chosen page's link, as Settings keeps it. */
const TARGET_URL = `https://app.notion.com/p/${hex(PAGE)}`
const OTHER = '4e4e4e4e-0000-4000-8000-000000000041'
const CLIPS = '5f5f5f5f-0000-4000-8000-000000000051'
const VIEW = 'b0b0b0b0-0000-4000-8000-000000000001'

/** A record as getSpaces and search wrap it. */
const wrapped = (record: Record<string, unknown>) => ({
  spaceId: SPACE,
  value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } },
})
/** getSpaces' answer for the tab's user: the workspace, and their view of it with `privatePages`. */
const spaces = (privatePages: string[]) => ({
  [USER]: {
    __version__: 3,
    space: { [SPACE]: wrapped({ id: SPACE, name: 'Fixture workspace' }) },
    space_view: { [VIEW]: wrapped({ id: VIEW, space_id: SPACE, private_pages: privatePages }) },
  },
})
/** A search's answer: one page found. */
const found = (id: string, title: string) => ({
  results: [{ id, score: 1 }],
  total: 1,
  recordMap: { __version__: 3, block: { [id]: wrapped({ id, type: 'page', properties: { title: [[title]] } }) } },
})

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
async function start({
  target = { url: TARGET_URL, title: 'Inbox' } as { url: string; title: string } | null,
  shown = true,
} = {}) {
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
  if (shown) tab.storage.syncValues.clipMenu = true
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

  it('[UC-NOTICO-SESSION-003-S02] a clip goes through the tab already showing the chosen page, and selected text keeps one item, "Ask Notico"', async () => {
    const { browser, tab, workspace } = await start()
    tab.otherTabs = [{ url: PAGE_URL, title: 'Inbox' }]
    // On selected text the extension has one item, which Chrome keeps at the menu's top level.
    expect([...tab.menuItems.values()].filter((item) => item.contexts?.includes('selection'))).toHaveLength(1)

    tab.pickMenuItem(CLIP_PAGE, '')

    expect(await clipped()).toHaveTextContent('Clipped to “Inbox”.')
    expect(browser.openedTabs).toEqual([])
    expect(tab.url).toBe(PAGE_URL)
    expect(workspace.content(PAGE).map((b) => [b.type, plain(b)])).toEqual([['page', 'Rivers | News']])
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

    tab.pickMenuItem(CLIP_PAGE, '')

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

    tab.pickMenuItem(CLIP_PAGE, '')

    await clipped()
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Notion didn't say whether the clip was written. Look at the end of “Inbox” before clipping again.",
    )
    expect(tab.sent.filter((r) => r.url.endsWith('/saveTransactionsFanout'))).toHaveLength(1)
    expect(workspace.content(PAGE).map((b) => b.type)).toEqual(['page'])
  })

  it('[UC-NOTICO-SESSION-003-S05] turning Clip on makes "Notico Clips" in Private the page clips go to, and turning it off hides the item', async () => {
    const { tab, workspace, user } = await start({ target: null, shown: false })
    tab.respond('getSpaces', 200, spaces([PAGE]))
    // Off until turned on: the items don't show.
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(false)
    await openSettings(user)
    const menu = within(screen.getByRole('region', { name: 'Right-click menu' }))
    expect(menu.queryByRole('button', { name: 'Clip into' })).toBeNull()

    // On a Notion page, turning it on makes the page clips go to, with nothing else to do.
    tab.switchTab(PAGE_URL, 'Inbox | Notion')
    await user.click(menu.getByRole('switch', { name: 'Clip to Notion' }))
    expect(await menu.findByRole('status')).toHaveTextContent(
      'Clips go to “Notico Clips”, made in your Private section.',
    )
    const made = [...workspace.records.values()].find((r) => plain(r) === 'Notico Clips')!
    expect(made).toMatchObject({ type: 'page', parent_id: SPACE, parent_table: 'space', private_view: VIEW })
    expect(menu.getByRole('link', { name: 'Open Notico Clips' })).toHaveAttribute(
      'href',
      `https://app.notion.com/p/${hex(made.id)}`,
    )
    expect(menu.getByRole('button', { name: 'Clip into' })).toBeVisible()
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(true)

    await user.click(menu.getByRole('switch', { name: 'Clip to Notion' }))
    expect(menu.queryByRole('button', { name: 'Clip into' })).toBeNull()
    expect(tab.menuItems.get(CLIP_PAGE)?.visible).toBe(false)
  })

  it('[@no-uc:notion-safety] "Notico Clips" is made once, however often it is asked for while it is being made', async () => {
    const { tab, workspace, user } = await start({ target: null, shown: false })
    tab.respond('getSpaces', 200, spaces([PAGE]))
    const release = tab.hold('saveTransactionsFanout')
    await openSettings(user)
    tab.switchTab(PAGE_URL, 'Inbox | Notion')
    const menu = within(screen.getByRole('region', { name: 'Right-click menu' }))

    await user.click(menu.getByRole('switch', { name: 'Clip to Notion' }))
    await waitFor(() => expect(tab.sent.some((r) => r.url.endsWith('/saveTransactionsFanout'))).toBe(true))
    // While it is being made, the switch waits, and the picker offers nothing: neither to make it
    // again, nor a page that it would replace once made.
    expect(menu.getByRole('switch', { name: 'Clip to Notion' })).toBeDisabled()
    await user.click(menu.getByRole('button', { name: 'Clip into' }))
    expect(await menu.findAllByText('Looking for “Notico Clips” in your Private section…')).not.toHaveLength(0)
    expect(menu.queryAllByRole('option')).toEqual([])

    release()
    expect(await menu.findByRole('status')).toHaveTextContent('made in your Private section')
    expect(workspace.transactions).toHaveLength(1)
  })

  it('[UC-NOTICO-SESSION-003-S07] a "Notico Clips" already in Private is used, not made again', async () => {
    const { tab, workspace, user } = await start({ target: null, shown: false })
    workspace.records.set(CLIPS, {
      ...workspace.records.get(PAGE)!,
      id: CLIPS,
      properties: { title: [['Notico Clips']] },
    })
    tab.respond('getSpaces', 200, spaces([CLIPS, PAGE]))
    await openSettings(user)
    tab.switchTab(PAGE_URL, 'Inbox | Notion')
    const menu = within(screen.getByRole('region', { name: 'Right-click menu' }))

    await user.click(menu.getByRole('switch', { name: 'Clip to Notion' }))

    expect(await menu.findByRole('status')).toHaveTextContent('Clips go to “Notico Clips”.')
    expect(menu.getByRole('link', { name: 'Open Notico Clips' })).toHaveAttribute(
      'href',
      `https://app.notion.com/p/${hex(CLIPS)}`,
    )
    expect(workspace.transactions).toEqual([])
  })

  it('[UC-NOTICO-SESSION-003-S08] "Clip into" offers the current page and finds others by what is typed; off Notion it says to open a page', async () => {
    const { tab, user } = await start({
      shown: true,
      target: { url: `https://app.notion.com/p/${hex(CLIPS)}`, title: 'Notico Clips' },
    })
    await openSettings(user)
    const menu = within(screen.getByRole('region', { name: 'Right-click menu' }))
    const box = menu.getByRole('button', { name: 'Clip into' })

    // Off Notion: there is no workspace to search.
    await user.click(box)
    expect(await menu.findByText('Open a Notion page in the current tab to search its workspace.')).toBeVisible()
    await user.keyboard('{Escape}')

    tab.switchTab(PAGE_URL, 'Inbox | Notion')
    await user.click(box)
    expect(await menu.findByRole('option', { name: /^Inbox\s*Current page/ })).toBeVisible()

    tab.respond('search', 200, found(OTHER, 'Reading list'))
    await user.type(menu.getByRole('searchbox', { name: 'Search pages' }), 'reading')
    await user.click(await menu.findByRole('option', { name: 'Reading list' }))
    // The picker closes, and the field shows the page chosen.
    expect(menu.queryByRole('listbox')).toBeNull()
    expect(box).toHaveTextContent('Reading list')
    expect(await menu.findByRole('status')).toHaveTextContent('Clips go to “Reading list”.')
    expect(menu.getByRole('link', { name: 'Open Reading list' })).toHaveAttribute(
      'href',
      `https://app.notion.com/p/${hex(OTHER)}`,
    )
    const search = tab.sent.find((r) => r.url.endsWith('/search'))!
    expect(search.body).toMatchObject({ query: 'reading', spaceId: SPACE })
  })
})

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}
