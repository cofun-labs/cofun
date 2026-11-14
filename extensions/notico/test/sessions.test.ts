// The side panel's saved sessions (extensions/notico/src/sessions.ts), on an in-memory IndexedDB.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../src/agent'
import {
  filterSessions,
  SessionStore,
  titleFor,
  type ListedSession,
  type Session,
  type SessionInfo,
} from '../src/sessions'

const ROADMAP = { title: 'Q4 Roadmap', url: 'https://www.notion.so/team/Q4-Roadmap-0a1b2c3d4e5f60718293a4b5c6d7e8f9' }
const NOTES_ID = '1111aaaa2222bbbb3333cccc4444dddd'
const NOTES = { title: 'Meeting notes', url: `https://www.notion.so/team/Meeting-notes-${NOTES_ID}` }

function conversation(question: string): HistoryMessage[] {
  return [
    { role: 'user', text: question },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'get_current_page', args: {} }] },
    { role: 'tool', id: 'call-1', name: 'get_current_page', status: 'done', result: JSON.stringify(ROADMAP) },
    { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
  ]
}

function session(id: string, question: string, updatedAt: number, page?: Session['page']): Session {
  const messages = conversation(question)
  return { id, title: titleFor(messages), page, createdAt: updatedAt - 1000, updatedAt, messages }
}

/** A session as `get` reads it, failing the test if it can't be read. */
async function load(store: SessionStore, id: string): Promise<Session | undefined> {
  const session = await store.get(id)
  if (session === 'unreadable') throw new Error(`session ${id} is unreadable`)
  return session
}

/** The listed sessions, failing the test if any of them can't be read. */
async function listed(store: SessionStore): Promise<SessionInfo[]> {
  return (await store.list()).map((s) => {
    if ('unreadable' in s) throw new Error(`session ${s.id} is unreadable`)
    return s
  })
}

/** The database `store` keeps its sessions in, opened beside it, as another version of the extension would. */
async function database(store: SessionStore): Promise<IDBDatabase> {
  // The store creates its database when first used.
  await store.list()
  const name = `notico-sessions-${users.get(store)}`
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Writes a record into one of the store's object stores as it is, unchecked. */
async function writeRaw(store: SessionStore, name: 'sessions' | 'messages', record: object): Promise<void> {
  const db = await database(store)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite')
    tx.objectStore(name).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function readRaw(store: SessionStore, name: 'sessions' | 'messages', id: string): Promise<unknown> {
  const db = await database(store)
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return result
}

let store: SessionStore
let n = 0
// Which account each store is for, to find its database.
const users = new WeakMap<SessionStore, string>()

beforeEach(() => {
  // A fresh account per test, so tests start with no sessions.
  const user = `user_${n++}`
  store = new SessionStore(user)
  users.set(store, user)
})

describe('saved sessions', () => {
  it('[UC-NOTICO-SESSION-001-S13] lists sessions most recently used first, with their titles', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'What changed last week?', 3000, NOTES))
    await store.save(session('c', 'Draft an agenda', 2000))

    const list = await listed(store)
    expect(list.map((s) => [s.title, s.page?.title])).toEqual([
      ['What changed last week?', 'Meeting notes'],
      ['Draft an agenda', undefined],
      ['Summarize this page', 'Q4 Roadmap'],
    ])
    // A session saved again after another question moves to the top and keeps its whole conversation.
    const a = (await load(store, 'a'))!
    const messages: HistoryMessage[] = [...a.messages, { role: 'user', text: 'Thanks' }]
    await store.save({ ...a, messages, updatedAt: 4000 }, a.updatedAt)
    const { messages: _, ...info } = a
    expect((await store.list())[0]).toEqual({ ...info, updatedAt: 4000 })
    expect(await store.get('a')).toEqual({ ...a, messages, updatedAt: 4000 })
  })

  it('a title the model wrote is given once, does not count as using the session, and later saves keep it', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Draft an agenda', 2000))
    const loaded = (await load(store, 'a'))!

    expect(await store.retitle('a', 'Page summary')).toBe(true)
    expect(await store.retitle('a', 'Another title')).toBe(false)
    expect(await store.retitle('gone', 'Page summary')).toBe(false)
    // Not moved up the list, and the next save from the panel that loaded it keeps the session's id.
    expect((await listed(store)).map((s) => [s.id, s.title, s.updatedAt])).toEqual([
      ['b', 'Draft an agenda', 2000],
      ['a', 'Page summary', 1000],
    ])
    const messages: HistoryMessage[] = [...loaded.messages, { role: 'user', text: 'Thanks' }]
    const saved = await store.save(
      { ...loaded, title: titleFor(messages), messages, updatedAt: 3000 },
      loaded.updatedAt,
    )
    expect(saved).toMatchObject({ id: 'a', title: 'Page summary', titledByModel: true })
    expect((await load(store, 'a'))?.title).toBe('Page summary')
  })

  it('[UC-NOTICO-SESSION-001-S12] search lists only the sessions whose title contains the query, ignoring case', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Summarize the decisions', 2000, NOTES))
    await store.save(session('c', 'Draft an agenda', 3000, NOTES))
    const all = await store.list()
    const ids = (sessions: ListedSession[]) => sessions.map((s) => s.id)

    expect(ids(filterSessions(all, 'SUMMARIZE'))).toEqual(['b', 'a'])
    expect(ids(filterSessions(all, ' the decisions '))).toEqual(['b'])
    expect(ids(filterSessions(all, 'Meeting notes'))).toEqual([])
    expect(ids(filterSessions(all, '  '))).toEqual(['c', 'b', 'a'])
  })

  it('[UC-NOTICO-SESSION-001-S05] a deleted session is no longer listed and cannot be reopened', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Draft an agenda', 2000))
    await store.delete('a')
    expect((await store.list()).map((s) => s.id)).toEqual(['b'])
    expect(await store.get('a')).toBeUndefined()
    expect((await load(store, 'b'))?.title).toBe('Draft an agenda')
  })

  it("[UC-NOTICO-SESSION-001-S09] another account on the same browser sees none of the first account's sessions", async () => {
    const alice = new SessionStore('user_alice_s09')
    const bob = new SessionStore('user_bob_s09')
    await alice.save(session('a', 'Summarize this page', 1000, ROADMAP))
    expect(await bob.list()).toEqual([])
    expect(await bob.get('a')).toBeUndefined()
    // Deleting under one account leaves the other's sessions alone.
    await bob.delete('a')
    expect((await alice.list()).map((s) => s.id)).toEqual(['a'])
  })

  it('[UC-NOTICO-SESSION-001-S10] a session continued in two windows keeps both conversations', async () => {
    // Two side panels of one user: two stores over the same database.
    const first = new SessionStore('user_s10')
    const second = new SessionStore('user_s10')
    const original = session('a', 'Summarize this page', 1000, ROADMAP)
    await first.save(original)
    const [inFirst, inSecond] = [(await load(first, 'a'))!, (await load(second, 'a'))!]

    const firstTurn: HistoryMessage[] = [...inFirst.messages, { role: 'user', text: 'Asked in the first window' }]
    const secondTurn: HistoryMessage[] = [...inSecond.messages, { role: 'user', text: 'Asked in the second window' }]
    const kept = await first.save({ ...inFirst, messages: firstTurn, updatedAt: 2000 }, inFirst.updatedAt)
    const copy = await second.save({ ...inSecond, messages: secondTurn, updatedAt: 3000 }, inSecond.updatedAt)

    // The session keeps the first window's conversation; the second window's is a session of its own.
    expect(kept.id).toBe('a')
    expect(copy.id).not.toBe('a')
    expect((await load(second, 'a'))?.messages).toEqual(firstTurn)
    expect(await first.get(copy.id)).toEqual({ ...inSecond, id: copy.id, messages: secondTurn, updatedAt: 3000 })
    expect((await first.list()).map((s) => s.id)).toEqual([copy.id, 'a'])

    // Each window goes on with its own session, and neither touches the other's again.
    const more: HistoryMessage[] = [...secondTurn, { role: 'user', text: 'And again' }]
    expect((await second.save({ ...copy, messages: more, updatedAt: 4000 }, copy.updatedAt)).id).toBe(copy.id)
    expect((await first.save({ ...kept, messages: firstTurn, updatedAt: 5000 }, kept.updatedAt)).id).toBe('a')
    expect((await load(first, copy.id))?.messages).toEqual(more)
    expect((await first.list()).map((s) => s.id)).toEqual(['a', copy.id])
  })

  it('of two panels saving the same session at the same moment, only one keeps it', async () => {
    const panels = [new SessionStore('user_race'), new SessionStore('user_race')]
    await panels[0].save(session('a', 'Summarize this page', 1000))
    const loaded = (await load(panels[0], 'a'))!
    const turns = panels.map((_, i): HistoryMessage[] => [...loaded.messages, { role: 'user', text: `Panel ${i}` }])

    // Neither waits for the other; both checks would pass if a check and its write were apart.
    const saved = await Promise.all(
      panels.map((panel, i) => panel.save({ ...loaded, messages: turns[i], updatedAt: 2000 }, loaded.updatedAt)),
    )

    expect(saved.filter((s) => s.id === 'a')).toHaveLength(1)
    const stored = await Promise.all(saved.map((s) => load(panels[0], s.id)))
    expect(stored.map((s) => s?.messages)).toEqual(turns)
    expect(await panels[0].list()).toHaveLength(2)
  })

  it('a session that changed since it was loaded is not overwritten, even by a save with the same time', async () => {
    await store.save(session('a', 'Summarize this page', 1000))
    const stale = (await load(store, 'a'))!
    await store.save({ ...stale, updatedAt: 2000 }, stale.updatedAt)
    // Loaded at 1000, stored at 2000 now: a save stamped 2000 is still not the one that wrote it.
    const copy = await store.save({ ...stale, title: 'Stale', updatedAt: 2000 }, stale.updatedAt)
    expect(copy.id).not.toBe('a')
    expect((await load(store, 'a'))?.title).toBe('Summarize this page')
    // A new session never takes over an id that is in use.
    expect((await store.save(session('a', 'Draft an agenda', 3000))).id).not.toBe('a')
    expect((await load(store, 'a'))?.title).toBe('Summarize this page')
  })

  it('a session deleted in another panel is saved again under its own id', async () => {
    await store.save(session('a', 'Summarize this page', 1000))
    const loaded = (await load(store, 'a'))!
    await new SessionStore(`user_${n - 1}`).delete('a')
    expect((await store.save({ ...loaded, updatedAt: 2000 }, loaded.updatedAt)).id).toBe('a')
    expect((await store.list()).map((s) => s.id)).toEqual(['a'])
  })

  it('a session that cannot be stored leaves nothing half-written', async () => {
    const bad = session('a', 'Summarize this page', 1000)
    // Functions can't be stored, so the conversation's write fails after the details' write ran.
    const messages = [{ role: 'user', text: 'x', extra: () => {} }] as unknown as HistoryMessage[]
    await expect(store.save({ ...bad, messages })).rejects.toThrow(/could not be cloned/)
    expect(await store.list()).toEqual([])
    // Nor does a failed save of a saved session change it.
    await store.save(bad)
    await expect(store.save({ ...bad, title: 'Changed', messages, updatedAt: 2000 }, 1000)).rejects.toThrow()
    expect(await store.get('a')).toEqual(bad)
  })

  it('an open store does not block a schema upgrade', async () => {
    const store = new SessionStore('user_upgrade')
    await store.save(session('a', 'Summarize this page', 1000))
    const upgrade = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('notico-sessions-user_upgrade', 2)
      req.onblocked = () => reject(new Error('blocked'))
      req.onsuccess = () => resolve(req.result)
    })
    expect(upgrade.version).toBe(2)
    upgrade.close()
  })

  it('a session whose details do not parse is listed after the others as unreadable, and can only be deleted', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Draft an agenda', 2000))
    // As an earlier version might have saved one: no times, and the title in another form.
    await writeRaw(store, 'sessions', { id: 'old', title: { text: 'Old chat' } })
    await writeRaw(store, 'messages', { id: 'old', messages: [{ role: 'user', text: 'Hi' }] })

    expect(await store.list()).toEqual([
      expect.objectContaining({ id: 'b' }),
      expect.objectContaining({ id: 'a' }),
      { id: 'old', unreadable: true },
    ])
    expect(await store.get('old')).toBe('unreadable')
    // It has no title for a search to match.
    expect(filterSessions(await store.list(), 'old').map((s) => s.id)).toEqual([])
    // Neither a title from the model nor another save writes over it.
    expect(await store.retitle('old', 'A title')).toBe(false)
    const fresh = session('old', 'New question', 3000)
    expect((await store.save(fresh)).id).not.toBe('old')
    expect(await readRaw(store, 'sessions', 'old')).toEqual({ id: 'old', title: { text: 'Old chat' } })

    await store.delete('old')
    expect((await store.list()).map((s) => s.id)).not.toContain('old')
    expect(await store.get('old')).toBeUndefined()
  })

  it('a session whose conversation does not parse cannot be opened, and is still listed', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    // A message of a kind this version doesn't know, and a tool call whose arguments are not an object.
    for (const messages of [
      [{ role: 'system', text: 'Be brief' }],
      [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'read_page', args: '{}' }] }],
      [{ role: 'tool', id: 'call-1', name: 'read_page', status: 'ok', result: '' }],
      { role: 'user', text: 'Not a list' },
    ]) {
      await writeRaw(store, 'messages', { id: 'a', messages })
      expect(await store.get('a')).toBe('unreadable')
    }
    expect((await listed(store)).map((s) => s.title)).toEqual(['Summarize this page'])
  })

  it('a session saved before the optional fields were added still reads', async () => {
    // As 0.1.0 saved them: no `titledByModel`, and questions without `pages` or details.
    await writeRaw(store, 'sessions', { id: 'a', title: 'Summarize this page', createdAt: 0, updatedAt: 1000 })
    await writeRaw(store, 'messages', { id: 'a', messages: conversation('Summarize this page') })
    expect(await store.get('a')).toEqual({
      id: 'a',
      title: 'Summarize this page',
      createdAt: 0,
      updatedAt: 1000,
      messages: conversation('Summarize this page'),
    })
  })

  it('a title is the first question on one line, cut to a readable length', () => {
    expect(titleFor([{ role: 'user', text: '  Line one\n\nline two ' }])).toBe('Line one line two')
    const long = titleFor([{ role: 'user', text: 'x'.repeat(300) }])
    expect(long).toHaveLength(100)
    expect(long.endsWith('…')).toBe(true)
    // An emoji where the cut falls stays whole.
    const emoji = titleFor([{ role: 'user', text: 'x'.repeat(98) + '🦩'.repeat(5) }])
    expect(Array.from(emoji)).toHaveLength(100)
    expect(emoji).toBe('x'.repeat(98) + '🦩…')
  })
})
