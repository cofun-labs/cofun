// The side panel's saved sessions (extension/src/sessions.ts), on an in-memory IndexedDB.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../src/agent'
import {
  filterSessions,
  pageKey,
  sessionPages,
  SessionStore,
  titleFor,
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

let store: SessionStore
let n = 0

beforeEach(() => {
  // A fresh account per test, so tests start with no sessions.
  store = new SessionStore(`user_${n++}`)
})

describe('saved sessions', () => {
  it('[UC-SESSION-001-S03] lists sessions most recently used first, titled with their first question', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'What changed last week?', 3000, NOTES))
    await store.save(session('c', 'Draft an agenda', 2000))

    const list = await store.list()
    expect(list.map((s) => [s.title, s.page?.title])).toEqual([
      ['What changed last week?', 'Meeting notes'],
      ['Draft an agenda', undefined],
      ['Summarize this page', 'Q4 Roadmap'],
    ])
    // A session saved again after another question moves to the top and keeps its whole conversation.
    const a = (await store.get('a'))!
    const messages: HistoryMessage[] = [...a.messages, { role: 'user', text: 'Thanks' }]
    await store.save({ ...a, messages, updatedAt: 4000 }, a.updatedAt)
    const { messages: _, ...info } = a
    expect((await store.list())[0]).toEqual({ ...info, updatedAt: 4000 })
    expect(await store.get('a')).toEqual({ ...a, messages, updatedAt: 4000 })
  })

  it('[UC-SESSION-001-S04] search by title and filter by the page a session started on', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Summarize the decisions', 2000, NOTES))
    // The same page opened in side peek from a database, on the other Notion host.
    await store.save(
      session('c', 'Draft an agenda', 3000, {
        ...NOTES,
        url: `https://app.notion.com/p/Projects-9999eeee8888ffff7777aaaa6666bbbb?p=${NOTES_ID}&pm=s`,
      }),
    )
    const all = await store.list()
    const ids = (sessions: SessionInfo[]) => sessions.map((s) => s.id)

    expect(ids(filterSessions(all, { query: 'SUMMARIZE' }))).toEqual(['b', 'a'])
    // The page in side peek on the other host counts as the same page.
    const pages = sessionPages(all)
    expect(pages.map((p) => p.title)).toEqual(['Meeting notes', 'Q4 Roadmap'])
    const notes = pages[0].key
    expect(notes).toBe(NOTES_ID)
    expect(ids(filterSessions(all, { page: notes }))).toEqual(['c', 'b'])
    expect(ids(filterSessions(all, { query: 'summarize', page: notes }))).toEqual(['b'])
    expect(ids(filterSessions(all, { query: '  ' }))).toEqual(['c', 'b', 'a'])
  })

  it('[UC-SESSION-001-S05] a deleted session is no longer listed and cannot be reopened', async () => {
    await store.save(session('a', 'Summarize this page', 1000, ROADMAP))
    await store.save(session('b', 'Draft an agenda', 2000))
    await store.delete('a')
    expect((await store.list()).map((s) => s.id)).toEqual(['b'])
    expect(await store.get('a')).toBeUndefined()
    expect((await store.get('b'))?.title).toBe('Draft an agenda')
  })

  it("[UC-SESSION-001-S09] another account on the same browser sees none of the first account's sessions", async () => {
    const alice = new SessionStore('user_alice_s09')
    const bob = new SessionStore('user_bob_s09')
    await alice.save(session('a', 'Summarize this page', 1000, ROADMAP))
    expect(await bob.list()).toEqual([])
    expect(await bob.get('a')).toBeUndefined()
    // Deleting under one account leaves the other's sessions alone.
    await bob.delete('a')
    expect((await alice.list()).map((s) => s.id)).toEqual(['a'])
  })

  it('[UC-SESSION-001-S10] a session continued in two windows keeps both conversations', async () => {
    // Two side panels of one user: two stores over the same database.
    const first = new SessionStore('user_s10')
    const second = new SessionStore('user_s10')
    const original = session('a', 'Summarize this page', 1000, ROADMAP)
    await first.save(original)
    const [inFirst, inSecond] = [(await first.get('a'))!, (await second.get('a'))!]

    const firstTurn: HistoryMessage[] = [...inFirst.messages, { role: 'user', text: 'Asked in the first window' }]
    const secondTurn: HistoryMessage[] = [...inSecond.messages, { role: 'user', text: 'Asked in the second window' }]
    const kept = await first.save({ ...inFirst, messages: firstTurn, updatedAt: 2000 }, inFirst.updatedAt)
    const copy = await second.save({ ...inSecond, messages: secondTurn, updatedAt: 3000 }, inSecond.updatedAt)

    // The session keeps the first window's conversation; the second window's is a session of its own.
    expect(kept.id).toBe('a')
    expect(copy.id).not.toBe('a')
    expect((await second.get('a'))?.messages).toEqual(firstTurn)
    expect(await first.get(copy.id)).toEqual({ ...inSecond, id: copy.id, messages: secondTurn, updatedAt: 3000 })
    expect((await first.list()).map((s) => s.id)).toEqual([copy.id, 'a'])

    // Each window goes on with its own session, and neither touches the other's again.
    const more: HistoryMessage[] = [...secondTurn, { role: 'user', text: 'And again' }]
    expect((await second.save({ ...copy, messages: more, updatedAt: 4000 }, copy.updatedAt)).id).toBe(copy.id)
    expect((await first.save({ ...kept, messages: firstTurn, updatedAt: 5000 }, kept.updatedAt)).id).toBe('a')
    expect((await first.get(copy.id))?.messages).toEqual(more)
    expect((await first.list()).map((s) => s.id)).toEqual(['a', copy.id])
  })

  it('of two panels saving the same session at the same moment, only one keeps it', async () => {
    const panels = [new SessionStore('user_race'), new SessionStore('user_race')]
    await panels[0].save(session('a', 'Summarize this page', 1000))
    const loaded = (await panels[0].get('a'))!
    const turns = panels.map((_, i): HistoryMessage[] => [...loaded.messages, { role: 'user', text: `Panel ${i}` }])

    // Neither waits for the other; both checks would pass if a check and its write were apart.
    const saved = await Promise.all(
      panels.map((panel, i) => panel.save({ ...loaded, messages: turns[i], updatedAt: 2000 }, loaded.updatedAt)),
    )

    expect(saved.filter((s) => s.id === 'a')).toHaveLength(1)
    const stored = await Promise.all(saved.map((s) => panels[0].get(s.id)))
    expect(stored.map((s) => s?.messages)).toEqual(turns)
    expect(await panels[0].list()).toHaveLength(2)
  })

  it('a session that changed since it was loaded is not overwritten, even by a save with the same time', async () => {
    await store.save(session('a', 'Summarize this page', 1000))
    const stale = (await store.get('a'))!
    await store.save({ ...stale, updatedAt: 2000 }, stale.updatedAt)
    // Loaded at 1000, stored at 2000 now: a save stamped 2000 is still not the one that wrote it.
    const copy = await store.save({ ...stale, title: 'Stale', updatedAt: 2000 }, stale.updatedAt)
    expect(copy.id).not.toBe('a')
    expect((await store.get('a'))?.title).toBe('Summarize this page')
    // A new session never takes over an id that is in use.
    expect((await store.save(session('a', 'Draft an agenda', 3000))).id).not.toBe('a')
    expect((await store.get('a'))?.title).toBe('Summarize this page')
  })

  it('a session deleted in another panel is saved again under its own id', async () => {
    await store.save(session('a', 'Summarize this page', 1000))
    const loaded = (await store.get('a'))!
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

  it('a page is the same page after a rename, on the other Notion host, and in side peek', () => {
    const id = '41233b11f78380158c48f4e72c4b0430'
    const keys = [
      `https://www.notion.so/team/To-Do-List-${id}`,
      `https://www.notion.so/team/Tasks-${id}?pvs=4`,
      `https://app.notion.com/p/To-Do-List-${id}`,
      `https://www.notion.so/team/${id}`,
      `https://www.notion.so/team/Projects-1111aaaa2222bbbb3333cccc4444dddd?p=${id}&pm=s`,
      `https://app.notion.com/p/41233b11-f783-8015-8c48-f4e72c4b0430`,
    ].map(pageKey)
    expect(new Set(keys)).toEqual(new Set([id]))
    // The database a page peeks from is another page.
    expect(pageKey('https://www.notion.so/team/Projects-1111aaaa2222bbbb3333cccc4444dddd')).not.toBe(id)
    // A URL without a page id falls back to the URL without its query.
    expect(pageKey('https://www.notion.so/team?pvs=4')).toBe('https://www.notion.so/team')
  })

  it('an open store does not block a schema upgrade', async () => {
    const store = new SessionStore('user_upgrade')
    await store.save(session('a', 'Summarize this page', 1000))
    const upgrade = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('notion-copilot-sessions-user_upgrade', 2)
      req.onblocked = () => reject(new Error('blocked'))
      req.onsuccess = () => resolve(req.result)
    })
    expect(upgrade.version).toBe(2)
    upgrade.close()
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
