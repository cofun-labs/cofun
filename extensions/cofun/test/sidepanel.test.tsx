import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { FakeSession } from '@cofun/app/test-clerk'
import '@testing-library/jest-dom/vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, type Env } from '../../../worker/src/app'
import { FakeClerk } from '../../../worker/test/clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeRateLimiter,
  FakeUsageDataset,
  FakeWeb,
  MODEL,
} from '../../../worker/test/fakes'

const EXTENSION = 'chrome-extension://bcdefghijklmnopabcdefghijklmnopa'
const NOW = new Date('2026-11-08T12:00:00Z')
const PAGE_URL = 'https://example.com/guide'

Element.prototype.scrollTo ??= () => {}

async function openPanel(session?: FakeSession) {
  const openedTabs: string[] = []
  const event = { addListener: () => {}, removeListener: () => {} }
  const emptyStorage = { get: async () => ({}) }
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.1' }), getURL: (path: string) => `${EXTENSION}/${path}` },
    cookies: { getAll: async () => [], onChanged: event },
    tabs: { create: async ({ url }: { url: string }) => void openedTabs.push(url) },
    storage: { onChanged: event, local: emptyStorage, session: emptyStorage },
    windows: { getCurrent: async () => ({ id: 1 }) },
  })
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const { fakeClerk } = await import('@cofun/app/test-clerk')
  if (session) fakeClerk.signIn(session)
  const page = new DOMParser().parseFromString(
    readFileSync(fileURLToPath(import.meta.resolve('../sidepanel.html')), 'utf8'),
    'text/html',
  )
  const entry = page.querySelector('script[type="module"]')!
  entry.remove()
  document.body.innerHTML = page.body.innerHTML
  await act(() => import(/* @vite-ignore */ entry.getAttribute('src')!))
  return openedTabs
}

afterEach(async () => {
  await act(async () => void window.dispatchEvent(new Event('pagehide')))
  document.body.innerHTML = ''
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('[UC-COFUN-PANEL-001-S01] opens Cofun’s sign-in page from its own panel', async () => {
  const openedTabs = await openPanel()
  expect(screen.getByText('Sign in to use Cofun.')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(openedTabs).toEqual(['https://copilot.test/login'])
})

it('[UC-COFUN-PANEL-001-S02] answers with a public web tool and shows credits from the same worker', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const clerk = await FakeClerk.create()
  const ai = new FakeAiBinding()
  ai.script.push(
    { toolCalls: [{ name: 'read_web_page', arguments: JSON.stringify({ url: PAGE_URL }) }] },
    { reply: 'The guide lists three steps.' },
  )
  const env: Env = {
    AI: ai,
    DB: new FakeD1Database(),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    API_LIMIT: new FakeRateLimiter(),
    WEB_LIMIT: new FakeRateLimiter(),
    RENDER_LIMIT: new FakeRateLimiter(),
    SEARCH_LIMIT: new FakeRateLimiter(),
    WEB: new FakeWeb().serve(
      PAGE_URL,
      '<title>Guide</title><main><p>These are the three steps in the guide.</p></main>',
    ),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXTENSION,
  }
  const worker = createApp()
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    worker.request(new Request(input, init), undefined, env, new FakeExecutionContext()),
  )
  const userId = 'user_example'
  await openPanel({
    userId,
    name: 'Alice Example',
    email: 'alice@example.com',
    getToken: () => clerk.sessionToken({ userId, azp: EXTENSION }),
  })
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'What does the guide say?{Enter}')
  expect(await screen.findByText('The guide lists three steps.')).toBeVisible()
  expect(JSON.stringify(ai.calls[1].inputs.messages)).toContain('These are the three steps in the guide.')
  expect(JSON.stringify(ai.calls[0].inputs.tools)).toContain('read_web_page')
  expect(JSON.stringify(ai.calls[0].inputs.tools)).not.toMatch(/edit_page|search_pages|query_database/)
  expect(screen.queryByRole('button', { name: 'Save reply to Notion' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Account/ }))
  await user.click(await screen.findByRole('menuitem', { name: /Credits/ }))
  expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
  expect(await screen.findByText('Free this week')).toBeVisible()
})
