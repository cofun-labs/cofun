import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DATA_LINE } from '@cofun/tools'
import { z } from '../src/zod'
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

/**
 * The side panel on a Confluence page whose site the user already allowed. `site` is the Confluence
 * base URL: a self-managed page names its deployment path in its metadata, a Cloud wiki is known by
 * its address.
 */
export async function openWorkspace(page: FixturePage, site = base) {
  const siteUrl = new URL(site)
  const contextPath = /(?:^|\.)atlassian\.net$/.test(siteUrl.hostname)
    ? undefined
    : siteUrl.pathname.replace(/\/+$/, '')
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async <T>(_name: string, action: () => Promise<T>) => action() },
  })
  const tab = new FakeTab(page.url)
  const workspaceRequests: { url: string; init?: RequestInit }[] = []
  function selectTab(next: FixturePage) {
    tab.switchTab(next.url, next.title)
    tab.documentId = next.documentId ?? 'fixture-document'
    const meta = contextPath === undefined ? '' : `<meta name="confluence-context-path" content="${contextPath}">`
    const dom = webPage({ title: next.title, url: next.url, head: meta, main: next.title })
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
          selector === 'iframe#wysiwygTextarea_ifr'
            ? { contentDocument: { body: editor } }
            : (dom as { querySelector(selector: string): unknown }).querySelector(selector),
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

  tab.allowed.add(siteUrl.origin + '/*')
  await browser.openPanel()
  await screen.findByRole('textbox', { name: 'Message' })
  return { browser, user: userEvent.setup(), tab }
}

export type WorkspaceBrowser = Awaited<ReturnType<typeof openWorkspace>>['browser']

export function closeWorkspace() {
  Reflect.deleteProperty(navigator, 'locks')
  return closeBrowser()
}

const modelRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string().nullish() })) })
const nextSearchPage = z.object({ nextPage: z.uuid() })

/** Script the model's continuation only when it has seen the preceding search result. */
export function followConfluencePage(browser: FakeBrowser, respond: (nextPage: string) => void) {
  const worker = browser.worker
  browser.worker = async (request) => {
    if (new URL(request.url).pathname === '/v1/chat/completions') {
      const body = modelRequest.safeParse(await request.clone().json())
      const content = body.data?.messages.findLast((message) => message.role === 'tool')?.content
      if (content?.startsWith(DATA_LINE + '\n')) {
        const next = nextSearchPage.safeParse(JSON.parse(content.slice(DATA_LINE.length + 1))).data
        if (next) {
          browser.worker = worker
          respond(next.nextPage)
        }
      }
    }
    return worker(request)
  }
}
