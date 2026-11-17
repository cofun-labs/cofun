import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { closeBrowser, FakeBrowser } from './panel'
import { FakeTab, webPage } from './tab'

export const base = 'https://wiki.example.test/kb'

interface FixturePage {
  id?: number
  url: string
  title: string
  documentId?: string
  editorSelection?: string
}

type SiteResponse = (url: string, init?: RequestInit) => Response | Promise<Response>

export async function openWorkspace(page: FixturePage) {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async <T>(_name: string, action: () => Promise<T>) => action() },
  })
  const tab = new FakeTab(page.url)
  const workspaceRequests: { url: string; init?: RequestInit }[] = []
  function selectTab(next: FixturePage) {
    tab.switchTab(next.url, next.title)
    tab.documentId = next.documentId ?? 'fixture-document'
    const dom = webPage({ title: next.title, url: next.url, main: next.title })
    if (next.editorSelection === undefined) tab.dom = dom
    else {
      const anchor = {}
      const surrounding = next.editorSelection + ' Other editor text'
      const editor = {
        textContent: surrounding,
        innerText: surrounding,
        getAttribute: () => 'true',
        contains: (node: unknown) => node === anchor,
        ownerDocument: {
          getSelection: () => ({
            anchorNode: anchor,
            focusNode: anchor,
            isCollapsed: !next.editorSelection,
            toString: () => next.editorSelection,
          }),
        },
      }
      tab.dom = {
        ...dom,
        querySelector: (selector: string) =>
          selector === 'iframe#wysiwygTextarea_ifr' ? { contentDocument: { body: editor } } : null,
      }
    }
  }
  selectTab(page)
  const missing: SiteResponse = (url) => {
    throw new Error('Missing fixture for ' + url)
  }
  const browser = Object.assign(await FakeBrowser.start(tab, { signedInAs: 'user_alice' }), {
    workspaceRequests,
    selectTab,
    confluenceResponse: missing,
  })
  tab.siteFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    workspaceRequests.push({ url, init })
    return browser.confluenceResponse(url, init)
  }

  await browser.openPanel()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  await user.type(await screen.findByLabelText('Confluence base URL'), base)
  await user.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected to ' + base)
  await user.click(screen.getByRole('button', { name: 'Back' }))
  return { browser, user, tab }
}

export type WorkspaceBrowser = Awaited<ReturnType<typeof openWorkspace>>['browser']

export function closeWorkspace() {
  Reflect.deleteProperty(navigator, 'locks')
  return closeBrowser()
}
