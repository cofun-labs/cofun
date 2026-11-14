// Adding Notion pages to a question with `@` or the "+" button, tested as a user meets it: the
// whole panel runs (see panel.ts), and the tests only type, click, and read what is on screen,
// besides what the model was sent and what Notion was asked.
import '@testing-library/jest-dom/vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(async () => {
  await closeBrowser()
  vi.unstubAllGlobals()
})

const hex = (id: string) => id.replace(/-/g, '')
const NOTE = '2c2c2c2c-0000-4000-8000-000000000021'
const ROADMAP = '2b2b2b2b-0000-4000-8000-000000000020'
const ROADMAP_URL = `https://app.notion.com/p/Roadmap-${hex(ROADMAP)}`
const LAUNCH = 'f1f1f1f1-0000-4000-8000-000000000001'
const TASKS = 'f1f1f1f1-0000-4000-8000-000000000002'

/** A Notion tab on the fixture page, whose workspace also has a child page, "Old notes"; another tab shows "Roadmap". */
function notionTab() {
  const page = (id: string, title: string, parent: string, content: string[] = []) => ({
    id,
    type: 'page',
    properties: { title: [[title]] },
    parent_id: parent,
    parent_table: 'block',
    content,
  })
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      { ...page(PAGE, 'Fixture page', SPACE, [NOTE]), parent_table: 'space' },
      page(NOTE, 'Old notes', PAGE),
    ],
    SPACE,
  )
  tab.otherTabs = [
    { url: ROADMAP_URL, title: 'Roadmap | Notion' },
    // Another site, and the fixture page open twice: neither is listed again.
    { url: 'https://mail.example.com/inbox', title: 'Inbox' },
    { url: PAGE_URL, title: 'Fixture page' },
  ]
  return tab
}

/** What Notion's search answers for "launch": a page, and a database. */
function searchAnswer() {
  const wrapped = (record: Record<string, unknown>) => ({
    spaceId: SPACE,
    value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } },
  })
  return {
    results: [
      {
        id: LAUNCH,
        highlight: {
          title: '<gzkNfoUU>Launch</gzkNfoUU> plan',
          pathText: 'Fixture workspace / Projects / <gzkNfoUU>Launch</gzkNfoUU> plan',
        },
      },
      { id: TASKS, highlight: { title: '<gzkNfoUU>Launch</gzkNfoUU> tasks', pathText: 'Fixture workspace' } },
    ],
    total: 2,
    recordMap: {
      block: {
        [LAUNCH]: wrapped({ id: LAUNCH, type: 'page', properties: { title: [['Launch plan']] } }),
        [TASKS]: wrapped({ id: TASKS, type: 'collection_view_page' }),
      },
    },
  }
}

/**
 * A browser signed in to Notico, with the side panel open on `tab`, and the clock's timers in the
 * test's hands: the workspace is searched only once typing pauses, and `pause` moves the clock on
 * past that pause, so a test that never pauses never searches.
 */
async function openPanel(tab = notionTab()) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  await screen.findByRole('list', { name: 'Pages to send' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: START })
  // Testing Library and user-event wait on zero timeouts between steps, which they run themselves
  // only on Jest's fake timers. Given these, they run the timers due now, never moving the clock, once
  // the browser has run its other work (IndexedDB, the tab's scripts): only `pause` moves the clock.
  const due = () => void setImmediate(() => vi.isFakeTimers() && vi.advanceTimersByTime(0))
  vi.stubGlobal('jest', { advanceTimersByTime: due })
  return { browser, tab, user: userEvent.setup({ advanceTimers: due }) }
}

const pause = (ms = 300) => act(async () => void vi.advanceTimersByTime(ms))

const composer = () => screen.getByRole('textbox', { name: 'Message' })
const conversation = () => within(screen.getByRole('main'))
const picker = () => screen.queryByRole('listbox', { name: 'Pages' })
/** The titles the picker lists in `group`, in order. */
const listed = (group: string) =>
  within(within(picker()!).getByRole('group', { name: group }))
    .getAllByRole('option')
    .map((o) => o.textContent)
/** The pages the composer will send the question with, as their titles. */
const toSend = () =>
  within(screen.getByRole('list', { name: 'Pages to send' }))
    .queryAllByRole('listitem')
    .map((li) => li.textContent)
const searches = (tab: FakeNotionTab) => tab.sent.filter((r) => r.url.endsWith('/api/v3/search'))
const answered = () => screen.findByRole('button', { name: 'Send' })
const sentQuestions = (browser: FakeBrowser) =>
  browser
    .sentToModel()
    .filter((m) => m.role === 'user')
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

async function ask(user: UserEvent, question: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

describe('UC-CHAT-004 add pages to a question', () => {
  it('[UC-CHAT-004-S01] @ lists this page, the other open tabs, and recent pages, filtered by what is typed, without asking Notion', async () => {
    const { browser, tab, user } = await openPanel()
    // An earlier chat, in which the agent read "Old notes".
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: NOTE }) }] },
      { reply: 'Read them.' },
    )
    await ask(user, 'Read the old notes')
    await screen.findByText('Read them.')
    await answered()
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    const sent = tab.sent.length
    const injected = tab.injections.length

    await user.type(composer(), 'Compare this with @')

    expect(await within(picker()!).findByRole('group', { name: 'Recent' })).toBeVisible()
    expect(listed('This page')).toEqual(['Fixture pageAdded'])
    expect(listed('Open tabs')).toEqual(['Roadmap'])
    // The page the chat started on is this page, listed above already.
    expect(listed('Recent')).toEqual(['Old notes'])

    await user.type(composer(), 'ol')
    await waitFor(() => expect(within(picker()!).queryByRole('group', { name: 'Open tabs' })).not.toBeInTheDocument())
    expect(listed('Recent')).toEqual(['Old notes'])
    // The typed text is in bold in the title.
    expect(within(picker()!).getByRole('option').querySelector('mark')).toHaveTextContent('Ol')

    // One character is too few to search the workspace: nothing matches it here.
    await user.type(composer(), '{Backspace}{Backspace}z')
    expect(await screen.findByText('No pages match “z”.')).toBeVisible()
    // Only what the browser already had: nothing was asked of Notion.
    expect(tab.sent).toHaveLength(sent)
    expect(tab.injections).toHaveLength(injected)
  })

  it('[UC-CHAT-004-S02] a page chosen with the keys becomes a chip in place of the @ text, and Escape leaves the text as it is', async () => {
    const { user } = await openPanel()

    await user.type(composer(), 'Compare this with @')
    await within(picker()!).findByRole('option', { name: /Roadmap/ })
    // This page comes first, then Roadmap.
    await user.keyboard('{ArrowDown}')
    expect(within(picker()!).getByRole('option', { name: /Roadmap/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')

    expect(picker()).not.toBeInTheDocument()
    expect(toSend()).toEqual(['Fixture page', 'Roadmap'])
    expect(composer()).toHaveValue('Compare this with ')
    expect(composer()).toHaveFocus()

    await user.type(composer(), '@ro')
    expect(await within(picker()!).findByRole('option', { name: /Roadmap.*Added/ })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(picker()).not.toBeInTheDocument()
    expect(composer()).toHaveValue('Compare this with @ro')
    // Typing on, past the same @, opens nothing.
    await user.type(composer(), 'ad')
    expect(picker()).not.toBeInTheDocument()

    // A press outside the message box does the same as Escape: coming back to it, the @ text stays text.
    await user.type(composer(), ' @fi')
    await within(picker()!).findByRole('option', { name: /Fixture page/ })
    await user.click(screen.getByRole('main'))
    expect(picker()).not.toBeInTheDocument()
    await user.click(composer())
    await user.keyboard('{End}')
    expect(picker()).not.toBeInTheDocument()
    expect(composer()).toHaveValue('Compare this with @road @fi')
  })

  it('[UC-CHAT-004-S03] "+" opens the same picker with its own search field, and leaves the message as it is', async () => {
    const { browser, tab, user } = await openPanel()
    await user.type(composer(), 'Summarize')

    await user.click(screen.getByRole('button', { name: 'Add a page' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add a page…' }))
    const field = screen.getByRole('searchbox', { name: 'Search pages' })
    expect(field).toHaveFocus()
    expect(await within(picker()!).findByRole('group', { name: 'Open tabs' })).toBeVisible()
    // Enter in the field with nothing to add yet neither sends the message nor closes the picker.
    await user.type(field, 'zq{Enter}')
    expect(field).toBeVisible()
    expect(composer()).toHaveValue('Summarize')
    expect(browser.ai.calls).toEqual([])
    await user.clear(field)

    // Words past a space list what Notion's search found, also pages it matched by content.
    tab.respond('search', 200, searchAnswer())
    await user.type(field, 'beta dates')
    await pause()
    expect(await within(picker()!).findByRole('option', { name: /Launch plan/ })).toBeVisible()
    expect(listed('Workspace')).toEqual(['Launch planFixture workspace / Projects', 'Launch tasksFixture workspace'])
    await user.clear(field)
    await user.type(field, 'road')
    await user.click(within(picker()!).getByRole('option', { name: /Roadmap/ }))

    expect(picker()).not.toBeInTheDocument()
    expect(toSend()).toEqual(['Fixture page', 'Roadmap'])
    expect(composer()).toHaveValue('Summarize')
  })

  it('[UC-CHAT-004-S04] Backspace in an empty message takes the last page off, then the one before it', async () => {
    const { browser, user } = await openPanel()
    await user.type(composer(), '@road')
    await within(picker()!).findByRole('option', { name: /Roadmap/ })
    await user.keyboard('{Enter}')
    expect(toSend()).toEqual(['Fixture page', 'Roadmap'])

    await user.type(composer(), '{Backspace}')
    expect(toSend()).toEqual(['Fixture page'])
    await user.type(composer(), '{Backspace}')
    expect(screen.queryByRole('list', { name: 'Pages to send' })).not.toBeInTheDocument()

    browser.ai.script.push({ reply: 'Which page?' })
    await ask(user, 'Summarize it')
    await answered()
    expect(sentQuestions(browser)).toEqual([expect.stringMatching(/^\[No Notion page is attached to this question/)])
  })

  it('[UC-CHAT-004-S05] the workspace is searched once typing pauses, one search at a time, with the newest text', async () => {
    const { tab, user } = await openPanel()
    tab.respond('search', 200, searchAnswer()).respond('search', 200, searchAnswer())

    // One character is not enough to search.
    await user.type(composer(), '@l')
    await pause()
    expect(searches(tab)).toEqual([])

    // Typing on before the pause replaces the query: only the newest goes out.
    await user.type(composer(), 'a')
    await pause(200)
    await user.type(composer(), 'u')
    expect(await screen.findByText('Searches your workspace when you stop typing.')).toBeVisible()
    await pause(299)
    expect(searches(tab)).toEqual([])
    const release = tab.hold('search')
    await pause(1)
    await waitFor(() => expect(searches(tab)).toHaveLength(1))
    expect(searches(tab)[0].body).toMatchObject({ query: 'lau', limit: 8 })
    expect(await screen.findByText('Searching your workspace…')).toBeVisible()

    // A query typed while that search runs waits for it: never two at once.
    await user.type(composer(), 'n')
    await pause()
    expect(searches(tab)).toHaveLength(1)
    await act(async () => release())
    await waitFor(() => expect(searches(tab)).toHaveLength(2))
    expect(searches(tab)[1].body).toMatchObject({ query: 'laun', limit: 8 })

    const launch = await within(picker()!).findByRole('option', { name: /Launch plan/ })
    expect(launch).toHaveTextContent('Launch planFixture workspace / Projects')
    expect(listed('Workspace')).toEqual(['Launch planFixture workspace / Projects', 'Launch tasksFixture workspace'])
    await user.keyboard('{Enter}')
    expect(toSend()).toEqual(['Fixture page', 'Launch plan'])
    expect(searches(tab)).toHaveLength(2)
  })

  it('[UC-CHAT-004-S06] Notion turning a search away stops searching for the question, and the other groups still work', async () => {
    const { browser, tab, user } = await openPanel()
    tab.limit('search', 1, 529)
    const release = tab.hold('search')

    // A newer query waits for the search already sent; that one is turned away, so the newer one is never sent.
    await user.type(composer(), '@road')
    await pause()
    await waitFor(() => expect(searches(tab)).toHaveLength(1))
    await user.type(composer(), 'm')
    await pause()
    await act(async () => release())
    expect(await screen.findByText(/Notion is busy, so your workspace isn’t searched for this question/)).toBeVisible()
    await pause()
    expect(searches(tab)).toHaveLength(1)
    // The pages already in the browser are still there to choose.
    await user.keyboard('{Enter}')
    expect(toSend()).toEqual(['Fixture page', 'Roadmap'])

    // Not retried, and no more searches for this question.
    await user.type(composer(), '@launch')
    await pause(5_000)
    expect(await screen.findByText(/Notion is busy/)).toBeVisible()
    expect(searches(tab)).toHaveLength(1)
    await user.keyboard('{Escape}')

    // The next question may search again.
    browser.ai.script.push({ reply: 'Done.' })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Done.')
    await answered()
    tab.respond('search', 200, searchAnswer())
    await user.type(composer(), '@launch')
    await pause()
    expect(await within(picker()!).findByRole('option', { name: /Launch plan/ })).toBeVisible()
    expect(searches(tab)).toHaveLength(2)
  })

  it('[UC-CHAT-004-S07] the AI is told the pages a question carries, and its bubble lists them, also after the session is reopened', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push({ reply: 'They differ.' })

    await user.type(composer(), 'Compare this with @road')
    await within(picker()!).findByRole('option', { name: /Roadmap/ })
    await user.keyboard('{Enter}')
    await ask(user, 'and the notes')
    await screen.findByText('They differ.')
    await answered()

    // Ids and titles only: nothing was read ahead of the question.
    expect(sentQuestions(browser)).toEqual([
      `[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]\n` +
        `[Pages the user added to this question: "Roadmap", ${ROADMAP_URL}]\n\n` +
        'Compare this with and the notes',
    ])
    expect(tab.sent).toEqual([])
    expect(pagesSent()).toEqual([['Fixture page', 'Roadmap']])
    // The next question starts with only the open page.
    expect(toSend()).toEqual(['Fixture page'])

    tab.url = 'https://mail.example.com/inbox'
    await browser.openPanel()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(
      await within(screen.getByRole('dialog', { name: 'Chats' })).findByRole('button', { name: /^Compare this/ }),
    )
    await conversation().findByText('Compare this with and the notes')
    expect(pagesSent()).toEqual([['Fixture page', 'Roadmap']])
  })

  it('[UC-CHAT-004-S10] an @ followed by ordinary words is sent as typed, and no page is added in their place', async () => {
    const { browser, tab, user } = await openPanel()
    browser.ai.script.push({ reply: 'Thanks.' }, { reply: 'Pinged.' }, { reply: 'Noted.' }, { reply: 'Will do.' })
    tab.respond('search', 200, searchAnswer()).respond('search', 200, searchAnswer())

    // With no page listed, Enter sends the message as typed, without waiting for a search: one
    // word that names no page, and words typed straight on.
    await user.type(composer(), 'thanks @bob{Enter}')
    await screen.findByText('Thanks.')
    await answered()
    await user.type(composer(), 'ping @road about it{Enter}')
    await screen.findByText('Pinged.')
    await answered()
    await pause()
    expect(searches(tab)).toEqual([])

    // A space right after the @ is no page: nothing opens, and nothing is searched.
    await user.type(composer(), 'Meet me @ 5pm')
    expect(picker()).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    await screen.findByText('Noted.')
    await answered()
    expect(searches(tab)).toEqual([])

    // Words past a space stay a page search while some page's title holds them, also one only the
    // workspace search finds…
    await user.type(composer(), '@launch pl')
    await pause()
    expect(await within(picker()!).findByRole('option', { name: /Launch plan/ })).toBeVisible()
    await user.keyboard('{Escape}')
    await user.clear(composer())

    // …and once no title does, they are the message going on: the picker closes, and Enter sends
    // them, even though the search found pages whose content may hold the words.
    await user.type(composer(), 'ping @road')
    expect(await within(picker()!).findByRole('group', { name: 'Open tabs' })).toBeVisible()
    await user.type(composer(), ' about it')
    await pause()
    await waitFor(() => expect(searches(tab)).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(/Searching your workspace/)).not.toBeInTheDocument())
    expect(picker()).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    await screen.findByText('Will do.')
    await answered()

    expect(sentQuestions(browser).map((q) => q?.split('\n\n').at(-1))).toEqual([
      'thanks @bob',
      'ping @road about it',
      'Meet me @ 5pm',
      'ping @road about it',
    ])
    expect(pagesSent()).toEqual([['Fixture page'], ['Fixture page'], ['Fixture page'], ['Fixture page']])
  })

  it('[UC-CHAT-004-S11] the picker and the AI never ask Notion at once', async () => {
    const { browser, tab, user } = await openPanel()
    tab.respond('search', 200, searchAnswer())

    // While a question is being answered, typing after an @ searches nothing…
    let resume!: () => void
    browser.ai.pause = { after: 150, until: new Promise<void>((resolve) => (resume = resolve)) }
    browser.ai.script.push({ reply: 'The roadmap has three milestones' })
    await user.type(composer(), 'Summarize{Enter}')
    await screen.findByRole('button', { name: 'Stop' })
    await user.type(composer(), '@launch')
    await pause()
    expect(await screen.findByText('Your workspace is searched once the answer is done.')).toBeVisible()
    expect(searches(tab)).toEqual([])
    // …until the answer is done.
    await act(async () => resume())
    await answered()
    await pause()
    expect(await within(picker()!).findByRole('option', { name: /Launch plan/ })).toBeVisible()
    expect(searches(tab)).toHaveLength(1)
    await user.keyboard('{Escape}')
    await user.clear(composer())

    // A question sent while a search is out waits for it, and stops when Notion turned it away.
    tab.limit('search', 1, 429)
    const release = tab.hold('search')
    await user.type(composer(), 'Compare @road')
    await pause()
    await waitFor(() => expect(searches(tab)).toHaveLength(2))
    const calls = browser.ai.calls.length
    const sent = tab.sent.length
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => release())
    expect(await screen.findByText(/Notion is turning requests away right now/)).toBeVisible()
    await answered()
    expect(browser.ai.calls).toHaveLength(calls)
    expect(tab.sent).toHaveLength(sent)

    // That search belonged to the question already sent: the next question searches again.
    tab.respond('search', 200, searchAnswer())
    await user.type(composer(), '@launch')
    await pause()
    expect(await within(picker()!).findByRole('option', { name: /Launch plan/ })).toBeVisible()
    expect(searches(tab)).toHaveLength(3)
    expect(screen.queryByText(/Notion is busy/)).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.clear(composer())

    // A failure nobody understands stops a question waiting for that search too.
    tab.respondText('search', 500, JSON.stringify({ name: 'UnexpectedError', message: 'Something broke' }))
    const broken = tab.hold('search')
    const sentBefore = searches(tab).length
    await user.type(composer(), 'Go @road')
    await pause()
    await waitFor(() => expect(searches(tab)).toHaveLength(sentBefore + 1))
    const askedBefore = browser.ai.calls.length
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => broken())
    expect(await screen.findByText(/Stopped after a Notion failure Notico doesn.t understand/)).toBeVisible()
    await answered()
    expect(browser.ai.calls).toHaveLength(askedBefore)

    // A question stopped, or left for a new chat, while it waits for a search is never asked.
    for (const leave of ['Stop', 'New chat']) {
      tab.respond('search', 200, searchAnswer())
      const answer = tab.hold('search')
      const before = searches(tab).length
      await user.type(composer(), 'Go @road')
      await pause()
      await waitFor(() => expect(searches(tab)).toHaveLength(before + 1))
      const asked = browser.ai.calls.length
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await user.click(screen.getByRole('button', { name: leave }))
      await act(async () => answer())
      await answered()
      expect(browser.ai.calls).toHaveLength(asked)
      if (leave === 'Stop') expect(conversation().getAllByText('Stopped').at(-1)).toBeVisible()
    }
    // The new chat answers its own question.
    browser.ai.script.push({ reply: 'Fresh.' })
    await user.type(composer(), 'Hello{Enter}')
    expect(await screen.findByText('Fresh.')).toBeVisible()
  })

  it('[UC-CHAT-004-S08] the open page taken off and picked again goes with the question, also once the tab moves on', async () => {
    const { browser, tab, user } = await openPanel()
    await user.click(screen.getByRole('button', { name: 'Remove Fixture page' }))
    expect(screen.queryByRole('list', { name: 'Pages to send' })).not.toBeInTheDocument()

    await user.type(composer(), '@fix')
    await user.click(await within(picker()!).findByRole('option', { name: /Fixture page/ }))
    // Added by hand, it is no longer the dashed chip that follows the tab.
    const chip = within(screen.getByRole('list', { name: 'Pages to send' })).getByRole('listitem')
    expect(chip).toHaveTextContent('Fixture page')
    expect(chip).not.toHaveClass('added')

    act(() => tab.navigate(ROADMAP_URL, 'Roadmap'))
    await waitFor(() => expect(toSend()).toEqual(['Roadmap', 'Fixture page']))
    browser.ai.script.push({ reply: 'Both.' })
    await ask(user, 'Compare them')
    await screen.findByText('Both.')
    await answered()
    expect(sentQuestions(browser)).toEqual([
      `[The Notion page open in the current tab: "Roadmap", ${ROADMAP_URL}]\n` +
        `[Pages the user added to this question: "Fixture page", ${PAGE_URL}]\n\nCompare them`,
    ])
  })
})
