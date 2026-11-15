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
const LAKES = 'https://news.example.com/2026/lakes?tags[]=calm'
/** Lakes' URL as the note names it: brackets escaped, so the URL can't close the note. */
const LAKES_NOTED = 'https://news.example.com/2026/lakes?tags%5B%5D=calm'
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

const readTab = (tab: number) => ({ toolCalls: [{ name: 'read_tab', arguments: JSON.stringify({ tab }) }] })

/** The result read_tab gives for a page on news.example.com, as the model gets it. */
const tabResult = (tab: number, title: string, url: string, text: string, notes: string[] = []) =>
  [
    DATA_LINE,
    `Page in tab ${tab}, which the user added, on news.example.com: ${JSON.stringify({ title, url })}`,
    ...notes,
    'Text:',
    text,
  ].join('\n')

const notAdded = (tab: number) =>
  `The user did not add tab ${tab} to this chat, so it was not read: read_tab reads only the tabs the ` +
  'notes list as added. Ask the user to add the tab, with "+" or @ in the message box.'

const GONE =
  'The tab the user added is not open any more (it was closed, or the browser restarted since), so nothing ' +
  'was read. Ask them to open the page and add its tab again.'

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

    expect(await screen.findByText('Notico may not read shop.example.org, so its tab wasn’t added.')).toBeVisible()
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
        `"Rivers | News" (tab 20), ${RIVERS}; "Lakes | News" (tab 21), ${LAKES_NOTED}]\n\n` +
        'Compare these',
    ])
    expect(tab.injections).toEqual([])
    expect(pagesSent()).toEqual([['Rivers | News', 'Lakes | News']])
    // The next question starts without them.
    expect(screen.queryByRole('list', { name: 'Pages to send' })).toBeNull()

    // A tab still open is gone to; one closed since has its page opened again.
    await user.click(
      within(conversation().getByRole('list', { name: 'Pages sent' })).getByRole('link', { name: 'Lakes | News' }),
    )
    expect(tab.url).toBe(LAKES)
    tab.otherTabs[0].closed = true
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

  it('[UC-NOTICO-CHAT-005-S04] the AI reads a tab added to the chat, also in a later question, and no tab the user did not add', async () => {
    const { browser, tab, user } = await openPanel((t) => t.allowed.add('https://shop.example.org/*'))
    browser.ai.script.push(
      readTab(20),
      readTab(21),
      { reply: 'Rivers are rising.' },
      readTab(20),
      // Open in the window, on a site Notico may read, but never added; and the current tab.
      readTab(22),
      readTab(7),
      { reply: 'Still rising.' },
    )

    await addTab(user, 'Rivers')
    await addTab(user, 'Lakes')
    await ask(user, 'What do these say?')
    await screen.findByText('Rivers are rising.')
    await answered()
    await ask(user, 'And now? Also check the shop')
    await screen.findByText('Still rising.')

    expect(toolResults(browser)).toEqual([
      tabResult(20, 'Rivers | News', RIVERS, 'Rivers are rising.'),
      tabResult(21, 'Lakes | News', LAKES, 'Lakes are calm.'),
      tabResult(20, 'Rivers | News', RIVERS, 'Rivers are rising.'),
      notAdded(22),
      notAdded(7),
    ])
    // The added tabs only, in the tabs themselves.
    expect(tab.injections).toEqual([
      { tabId: 20, world: 'ISOLATED' },
      { tabId: 21, world: 'ISOLATED' },
      { tabId: 20, world: 'ISOLATED' },
    ])
  })

  it('[UC-NOTICO-CHAT-005-S04] a tab that went to another page is read as it is now, and the AI is told it moved', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push(readTab(20), { reply: 'It moved.' })

    await addTab(user, 'Rivers')
    Object.assign(tab.otherTabs[0], {
      url: 'https://news.example.com/2026/front',
      title: 'Front | News',
      dom: webPage({ title: 'Front | News', main: 'Today on the front page.' }),
    })
    await ask(user, 'What does it say?')
    await screen.findByText('It moved.')

    expect(toolResults(browser)).toEqual([
      tabResult(20, 'Front | News', 'https://news.example.com/2026/front', 'Today on the front page.', [
        `[The tab went to another page since the user added it, when it showed ${JSON.stringify(RIVERS)}.]`,
      ]),
    ])
  })

  it('[UC-NOTICO-CHAT-005-S03] a long address is named clipped in the note', async () => {
    const LONG = `https://news.example.com/play#state=${'a'.repeat(3_000)}`
    const { browser, user } = await openPanel((t) => {
      t.otherTabs[0] = { url: LONG, title: 'Playground', dom: webPage({ title: 'Playground', main: 'Some code.' }) }
    })
    browser.ai.script.push({ reply: 'Noted.' })

    await addTab(user, 'Playground')
    await ask(user, 'What is this?')
    await screen.findByText('Noted.')

    expect(sentQuestions(browser)[0]).toContain(`"Playground" (tab 20), ${LONG.slice(0, 2_000)}]`)
  })

  it('[UC-NOTICO-CHAT-005-S05] after a restart, a tab a saved chat holds is not read, even once another chat adds a tab with its id', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push({ reply: 'First chat.' }, { reply: 'Second chat.' }, readTab(20), { reply: 'Not that one.' })

    await addTab(user, 'Rivers')
    await ask(user, 'Remember this tab')
    await screen.findByText('First chat.')
    await answered()

    // The browser restarts; in a new chat the user adds a tab Chrome gave the same id to.
    tab.storage.restart()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await addTab(user, 'Rivers')
    await ask(user, 'Another chat')
    await screen.findByText('Second chat.')
    await answered()

    // Back in the first chat, that id is not the tab it was added as.
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(
      await within(screen.getByRole('dialog', { name: 'Chats' })).findByRole('button', { name: /^Remember this tab/ }),
    )
    await conversation().findByText('Remember this tab')
    await ask(user, 'What does it say now?')
    await screen.findByText('Not that one.')

    expect(toolResults(browser)).toEqual([GONE])
    expect(tab.injections).toEqual([])
    // Its link opens the page again, rather than going to the tab that has its id now.
    await user.click(
      within(conversation().getAllByRole('list', { name: 'Pages sent' })[0]).getByRole('link', {
        name: 'Rivers | News',
      }),
    )
    expect(browser.openedTabs).toEqual([RIVERS])
  })

  it('[UC-NOTICO-CHAT-005-S05] a tab added that was closed, or added before the browser restarted, is not read', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push(readTab(20), { reply: 'It is gone.' }, readTab(21), { reply: 'Gone too.' })

    await addTab(user, 'Rivers')
    tab.otherTabs[0].closed = true
    await ask(user, 'What does it say?')
    await screen.findByText('It is gone.')
    await answered()

    // After a restart Chrome hands out tab ids again: an id a chat kept may be another tab's now.
    await addTab(user, 'Lakes')
    tab.storage.restart()
    await ask(user, 'And this one?')
    await screen.findByText('Gone too.')

    expect(toolResults(browser)).toEqual([GONE, GONE])
    expect(tab.injections).toEqual([])
  })
})
