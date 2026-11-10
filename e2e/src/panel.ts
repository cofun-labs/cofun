// The Notion tab this tool opens, the side panel next to it, and asking questions there.
import { isNotion } from '../../extension/src/notion/hosts'
import type { Answer } from './args'
import { type Browser, type Target, sleep, until } from './cdp'
import { E2eError } from './errors'
import { EXTENSION_ID } from './extension'
import { type PanelSnapshot, type ReplyPart, nextStep, readPanel } from './reply'
import type { State } from './state'

const PANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`
/** Where `page` and `db` open a Notion tab when this tool has none yet. */
export const DEFAULT_NOTION_URL = process.env.E2E_NOTION_URL ?? 'https://app.notion.com/'

/** The Notion tab this tool opened, if it is still open. */
export async function ownNotionTab(browser: Browser, state: State): Promise<string | undefined> {
  return (await browser.exists(state.notionTarget)) ? state.notionTarget : undefined
}

/**
 * The tool's Notion tab, at `url` if given: an open one is navigated there, otherwise a new tab
 * opens. Without a url, the open one is kept; if there is none, a tab opens at `fallback`, or this
 * fails when there is no fallback. Waits until Notion has loaded, signed in.
 */
export async function notionTab(
  browser: Browser,
  state: State,
  url: string | undefined,
  fallback?: string,
): Promise<Target> {
  let id = await ownNotionTab(browser, state)
  const target = url ?? (id ? undefined : fallback)
  if (!id && !target) throw new E2eError('No Notion tab opened by pnpm e2e yet: pass a Notion page URL.')
  if (id && target) {
    const old = await browser.attach(id)
    // Marks the old document, so the wait below doesn't take it for the new one.
    await old.evaluate(() => void ((window as { e2eOld?: boolean }).e2eOld = true), [])
    await old.send('Page.navigate', { url: target })
  } else if (!id) {
    id = await browser.open(target!)
    state.notionTarget = id
    state.panelTarget = undefined
  }
  const tab = await browser.attach(id!)
  const loaded = await until(
    () =>
      tab.evaluate(
        () =>
          document.readyState === 'complete' && !(window as { e2eOld?: boolean }).e2eOld
            ? { url: location.href, signedIn: /(?:^|;\s*)notion_user_id=/.test(document.cookie) }
            : undefined,
        [],
      ),
    { ms: 30_000, onTimeout: () => new E2eError('The Notion tab did not finish loading.') },
  )
  if (!isNotion(loaded.url)) throw new E2eError('The Notion tab is not on Notion any more.')
  if (!loaded.signedIn) throw new E2eError('Notion is signed out in this browser. Sign in by hand, then try again.')
  return tab
}

/** Opens the side panel for the tool's Notion tab, starts a new chat, and returns the panel. */
export async function openPanel(browser: Browser, state: State, notion: Target): Promise<Target> {
  // The panel works on the active tab of its window.
  await browser.activate(notion.targetId)
  const url = await notion.evaluate(() => location.href, [])

  // chrome.sidePanel.open needs a user gesture in an extension page: open one of ours in a helper
  // tab, call it there as a click, and close the tab.
  const helperId = await browser.open(PANEL_URL, { background: true })
  let tabId: number
  try {
    const helper = await browser.attach(helperId)
    const tabs = await until(
      () =>
        helper.evaluate(
          (u: string) =>
            typeof chrome?.tabs?.query === 'function'
              ? chrome.tabs.query({}).then((all) => all.filter((t) => t.url === u).map((t) => t.id!))
              : undefined,
          [url],
        ),
      {
        ms: 10_000,
        onTimeout: () =>
          new E2eError('The extension page did not load. Is the extension enabled? Run pnpm e2e reload to check.'),
      },
    )
    if (tabs.length !== 1) {
      throw new E2eError(
        tabs.length ? 'Several tabs show this Notion page; close the others and try again.' : 'Lost the Notion tab.',
      )
    }
    tabId = tabs[0]
    await helper.evaluate((id: number) => chrome.sidePanel.open({ tabId: id }), [tabId], { userGesture: true })
  } finally {
    await browser.close(helperId)
  }

  // The panel is the extension page whose window's active tab is ours.
  const panel = await until(
    async () => {
      for (const t of await browser.targets()) {
        if (!t.url.startsWith(PANEL_URL) || t.targetId === helperId) continue
        const page = await browser.attach(t.targetId)
        const active = await page.evaluate(
          () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.id),
          [],
        )
        if (active === tabId) return page
      }
      return undefined
    },
    { ms: 10_000, onTimeout: () => new E2eError('The side panel did not open.') },
  )
  state.panelTarget = panel.targetId

  const snap = await until(
    async () => {
      const s = await panel.evaluate(readPanel, [])
      if (s.ready) return s
      const signIn = await panel.evaluate(
        () => [...document.querySelectorAll('button')].some((b) => /sign in/i.test(b.textContent ?? '')),
        [],
      )
      return signIn ? s : undefined
    },
    { ms: 20_000, onTimeout: () => new E2eError('The side panel did not finish loading.') },
  )
  if (!snap.ready) throw new E2eError('Copilot is signed out in the side panel. Sign in by hand, then try again.')
  if (snap.busy) throw new E2eError('A reply is still running in the side panel; wait for it with pnpm e2e ask.')
  if (snap.replies > 0) await clickButton(panel, '.toolbar button', 'New chat')
  return panel
}

/** The side panel `panel` opened, if it is still open. */
export async function ownPanel(browser: Browser, state: State): Promise<Target> {
  if (!(await browser.exists(state.panelTarget))) {
    throw new E2eError('No side panel opened by pnpm e2e is open: run pnpm e2e panel first.')
  }
  return browser.attach(state.panelTarget!)
}

export interface AskResult {
  status: 'done' | 'needs_answer'
  parts: ReplyPart[]
}

/**
 * Sends `question` (or, without one, keeps watching the last reply) and waits until the reply is
 * done or asks for an approval nobody said how to answer.
 */
export async function ask(
  panel: Target,
  question: string | undefined,
  answer: Answer | undefined,
  timeoutMs: number,
): Promise<AskResult> {
  let snap = await panel.evaluate(readPanel, [])
  if (!snap.ready) throw new E2eError('Copilot is signed out in the side panel. Sign in by hand, then try again.')
  let expected = snap.replies
  if (question !== undefined) {
    if (snap.busy) {
      throw new E2eError('A reply is still running; run pnpm e2e ask without a question to wait for it.')
    }
    await panel.evaluate(
      (text: string) => {
        const box = document.querySelector<HTMLTextAreaElement>('#composer textarea')!
        // React tracks the value itself; set it the way typing does, so onChange sees it.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      },
      [question],
    )
    await sleep(100)
    await clickButton(panel, '#composer button[type=submit]', 'Send')
    expected++
  } else if (expected === 0) throw new E2eError('Nothing has been asked in the side panel yet.')

  const started = Date.now()
  for (;;) {
    snap = await panel.evaluate(readPanel, [])
    const step = nextStep(snap, expected, answer)
    if (step === 'done' || step === 'needs_answer') return { status: step, parts: snap.parts }
    if (typeof step === 'object') {
      await clickButton(panel, '#messages .msg.assistant:last-child .tool-confirm button', label(step.click))
    } else if (snap.replies < expected && Date.now() - started > 5_000) {
      throw new E2eError('The question was not sent.')
    }
    if (Date.now() - started > timeoutMs) {
      throw new TimeoutError(snap)
    }
    await sleep(500)
  }
}

export class TimeoutError extends E2eError {
  constructor(readonly snapshot: PanelSnapshot) {
    super('Timed out waiting for the reply; run pnpm e2e ask without a question to keep waiting.')
  }
}

function label(answer: Answer): string {
  return answer === 'allow' ? 'Allow' : 'Deny'
}

async function clickButton(page: Target, selector: string, text: string): Promise<void> {
  const clicked = await page.evaluate(
    (sel: string, t: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent?.trim() === t)
      button?.click()
      return !!button
    },
    [selector, text],
  )
  if (!clicked) throw new E2eError(`No "${text}" button in the side panel.`)
}
