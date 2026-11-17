import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionStore } from '../src/sessions'

afterEach(() => void vi.useRealTimers())

it('[UC-CONFLUCO-SESSION-001-S09] keeps a saved conversation private to the account that made it', async () => {
  const alice = new SessionStore('user_alice')
  const bob = new SessionStore('user_bob')
  await alice.save({
    id: 'chat',
    title: 'Private notes',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [{ role: 'user', text: 'Private notes' }],
  })

  expect(await bob.list()).toEqual([])
  expect(await bob.get('chat')).toBeUndefined()
  await bob.delete('chat')
  expect(await alice.get('chat')).toMatchObject({ title: 'Private notes' })
})

it('[UC-CONFLUCO-PANEL-005-S05] expires full tool results whether or not the chat was saved', async () => {
  const store = new SessionStore('user_alice_results')
  const storedAt = Date.UTC(2026, 10, 17)
  vi.useFakeTimers({ toFake: ['Date'], now: storedAt })
  const result = {
    tool: 'read_web_page',
    url: 'https://example.com/',
    title: 'Long page',
    text: 'A page',
    chars: 6,
    markdown: false,
  }
  const unlinked = await store.keep(result)
  const linked = await store.keep(result)
  await store.save({
    id: 'chat',
    title: 'Read a page',
    createdAt: storedAt,
    updatedAt: storedAt,
    messages: [
      {
        role: 'tool',
        id: 'call',
        name: 'read_web_page',
        status: 'done',
        result: 'First part',
        details: { result: linked },
      },
    ],
  })
  vi.setSystemTime(storedAt + 7 * 24 * 60 * 60 * 1000 - 1)
  await store.sweep()
  expect(await store.result(linked)).toBeDefined()
  expect(await store.result(unlinked)).toBeDefined()

  vi.setSystemTime(storedAt + 7 * 24 * 60 * 60 * 1000 + 1)
  await store.sweep()
  expect(await store.result(linked)).toBeUndefined()
  expect(await store.result(unlinked)).toBeUndefined()
  expect(await store.get('chat')).toMatchObject({ id: 'chat' })
})

it('[@no-uc:data] never restores a retired Confluence undo when a stale panel forks its chat', async () => {
  const first = new SessionStore('user_confluence_undo_revision')
  const second = new SessionStore('user_confluence_undo_revision')
  const draft = {
    id: 'confluence-undo',
    title: 'Synthetic chat',
    createdAt: 10,
    updatedAt: 11,
    messages: [],
    undo: {
      page: { instance: 'https://wiki.example.test/kb', id: '42' },
      version: 2,
      before: 'Old',
      after: 'New',
    },
  }
  await first.save(draft)
  const stale = await second.get(draft.id)
  if (!stale || stale === 'unreadable') throw new Error('Expected a saved chat')
  await first.clearUndo(draft.id, draft.updatedAt)
  const fork = await second.save({ ...stale, updatedAt: 12 }, stale.updatedAt)
  expect(fork.id).not.toBe(draft.id)
  expect(await second.get(fork.id)).not.toHaveProperty('undo')
  expect(await first.get(draft.id)).not.toHaveProperty('undo')
})
