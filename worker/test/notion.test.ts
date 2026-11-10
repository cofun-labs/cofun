// The extension's Notion API client (extension/src/notion/), against a fake Notion tab that serves
// sanitized fixtures of Notion's responses.
import { afterEach, describe, expect, it } from 'vitest'
import {
  NotionClient,
  NotionError,
  RATE_LIMITED,
  normalizeRecordMap,
  type NotionResponse,
  type NotionTransport,
  type Operation,
  type Wait,
} from '../../extension/src/notion/api'
import { pageIdFromUrl } from '../../extension/src/notion/hosts'
import { activeNotionTab, tabTransport } from '../../extension/src/notion/tab'
import {
  BLOCKS,
  FakeNotionTab,
  FakeWorkspace,
  PAGE,
  PAGE_URL,
  SPACE,
  USER,
  fixture,
  notionError,
  pageTab,
  restoreGlobals,
} from './notion-tab'

afterEach(restoreGlobals)

describe('the open page', () => {
  it('reads the page id from Notion URLs', () => {
    const hex = PAGE.replace(/-/g, '')
    expect(pageIdFromUrl(`https://www.notion.so/team/Fixture-page-${hex}`)).toBe(PAGE)
    expect(pageIdFromUrl(`https://app.notion.com/p/${hex}`)).toBe(PAGE)
    expect(pageIdFromUrl(`https://www.notion.so/${PAGE}`)).toBe(PAGE)
    expect(pageIdFromUrl(`https://www.notion.so/Cafe-${hex}?v=${'f'.repeat(32)}#${'e'.repeat(32)}`)).toBe(PAGE)
    // A page open in side peek is the one the user is looking at.
    expect(pageIdFromUrl(`https://www.notion.so/team/Board-${'a'.repeat(32)}?p=${hex}&pm=s`)).toBe(PAGE)
    expect(pageIdFromUrl('https://www.notion.so/')).toBeUndefined()
    expect(pageIdFromUrl('https://app.notion.com/team/home')).toBeUndefined()
    expect(pageIdFromUrl('not a url')).toBeUndefined()
  })

  it('finds the Notion tab of the window and the page it shows', async () => {
    new FakeNotionTab(PAGE_URL).install()
    const tab = await activeNotionTab()
    expect([tab.tabId, tab.url, tab.pageId]).toEqual([7, PAGE_URL, PAGE])

    new FakeNotionTab('https://www.notion.so/').install()
    expect((await activeNotionTab()).pageId).toBeUndefined()
  })

  it('reports no Notion tab for other sites, and never calls them', async () => {
    for (const url of ['https://mail.example.com/inbox', 'https://www.notion.so.evil.example/x', undefined]) {
      const tab = new FakeNotionTab(url).install()
      const err = await notionError(activeNotionTab())
      expect([err.code, err.message]).toEqual(['no_notion_tab', 'No Notion page is open in this window.'])
      expect(tab.injections).toEqual([])
    }
  })
})

describe('requests', () => {
  it('run in the Notion tab, out of reach of the page, as the tab’s signed-in user', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    await client.loadPage(PAGE)

    expect(tab.injections).toEqual([
      { tabId: 7, world: 'ISOLATED' },
      { tabId: 7, world: 'ISOLATED' },
    ])
    // The tab's own origin: the Notion session belongs to that host only.
    expect(tab.sent.map((r) => r.url)).toEqual([
      'https://app.notion.com/api/v3/loadPageChunk',
      'https://app.notion.com/api/v3/loadPageChunk',
    ])
    expect(tab.sent[0].headers).toEqual({ 'content-type': 'application/json', 'x-notion-active-user-header': USER })
    // Once the workspace is known, it goes with every request.
    expect(tab.sent[1].headers).toEqual({
      'content-type': 'application/json',
      'x-notion-active-user-header': USER,
      'x-notion-space-id': SPACE,
    })
  })

  it('go to www.notion.so from a www.notion.so tab', async () => {
    const tab = pageTab(`https://www.notion.so/team/Fixture-page-${PAGE.replace(/-/g, '')}`)
    await (await activeNotionTab()).client.loadPage(PAGE)
    expect(tab.sent[0].url).toBe('https://www.notion.so/api/v3/loadPageChunk')
  })

  it('stop when the tab left Notion after it was picked', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.pageUrl = 'https://mail.example.com/inbox'
    expect((await notionError(client.loadPage(PAGE))).code).toBe('no_notion_tab')
    expect(tab.sent).toEqual([])
  })

  it('report no Notion tab when the tab is gone', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.closed = true
    expect((await notionError(client.loadPage(PAGE))).code).toBe('no_notion_tab')
  })

  it('ask for site access when Chrome refuses to run in the tab, and say nothing was sent', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.injectionError = 'Cannot access contents of the page. Extension manifest must request permission.'
    const err = await notionError(client.loadPage(PAGE))
    expect(err.code).toBe('notion_error')
    expect(err.message).toMatch(/^Notion Copilot is not allowed to access this Notion site\./)
    expect(err.unanswered).toBe(false)
    // A change that was never sent is not an unknown outcome.
    const write = await notionError(client.submitTransaction(SPACE, [], 'test'))
    expect(write.code).toBe('notion_error')
  })

  it('report a tab that left Notion as no Notion tab, not missing site access', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.pageUrl = 'https://mail.example.com/'
    tab.injectionError = 'Cannot access contents of url "https://mail.example.com/".'
    const err = await notionError(client.loadPage(PAGE))
    expect([err.code, err.unanswered]).toEqual(['no_notion_tab', false])
  })

  it('treat other failures that mention permission as possibly sent', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.injectionError = 'Frame was removed while checking permission.'
    expect((await notionError(client.loadPage(PAGE))).unanswered).toBe(true)
  })

  it('report other failures to run in the tab as Notion errors, with the reason', async () => {
    const tab = pageTab()
    const { client } = await activeNotionTab()
    tab.injectionError = 'Frame with ID 0 was removed.'
    const err = await notionError(client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual([
      'notion_error',
      'Could not run in the Notion tab: Frame with ID 0 was removed.',
    ])
  })

  it('send the workspace of the request, not of an earlier one', async () => {
    const other = '5b5b5b5b-0000-4000-8000-000000000009'
    const tab = pageTab()
      .respond('syncRecordValuesMain', 200, fixture('sync-record-values'))
      .respond('saveTransactionsFanout', 200, {})
      .respond('syncRecordValuesMain', 200, fixture('sync-record-values'))
    const { client } = await activeNotionTab()
    await client.loadPage(PAGE)
    await client.getRecords([{ table: 'block', id: BLOCKS[0] }])
    await client.submitTransaction(other, [], 'edit')
    await client.getRecords([{ table: 'block', id: BLOCKS[0], spaceId: SPACE }])
    expect(tab.sent.map((r) => r.headers['x-notion-space-id'])).toEqual([undefined, SPACE, undefined, other, SPACE])
  })

  it('give up on a stalled request instead of hanging', async () => {
    const tab = pageTab()
    await (await activeNotionTab()).client.loadPage(PAGE)
    expect(tab.signals).toHaveLength(2)
    for (const signal of tab.signals) expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('do not follow a redirect, and report it', async () => {
    const tab = new FakeNotionTab(PAGE_URL).respond('saveTransactionsFanout', 200, {}).install()
    tab.redirects = true
    const op: Operation = { pointer: { table: 'block', id: PAGE }, path: [], command: 'update', args: {} }
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [op], 'edit'))
    // Notion answered, so the change was not saved: not an unknown outcome.
    expect([err.code, err.message]).toEqual(['notion_error', 'Notion redirected the request instead of answering it.'])
    expect(tab.sent.map((r) => r.url)).toEqual(['https://app.notion.com/api/v3/saveTransactionsFanout'])

    const signedOut = new FakeNotionTab(PAGE_URL, 'notion_browser_id=b').respond('loadPageChunk', 200, {}).install()
    signedOut.redirects = true
    expect((await notionError((await activeNotionTab()).client.loadPage(PAGE))).code).toBe('signed_out')
  })

  it('report a network failure as a Notion error', async () => {
    const tab = pageTab()
    tab.networkDown = true
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual(['notion_error', 'Could not reach Notion: Failed to fetch'])
  })
})

describe('loading a page', () => {
  it('follows the cursor until the page is complete and unwraps every record once', async () => {
    const tab = pageTab()
    const loaded = await (await activeNotionTab()).client.loadPage(PAGE)

    expect(tab.sent.map((r) => r.body)).toEqual([
      { page: { id: PAGE }, limit: 100, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
      {
        page: { id: PAGE },
        limit: 100,
        cursor: { stack: [[{ table: 'block', id: PAGE, index: 2 }]] },
        chunkNumber: 1,
        verticalColumns: false,
      },
    ])
    expect(loaded.complete).toBe(true)
    expect(loaded.spaceId).toBe(SPACE)
    expect(loaded.page).toMatchObject({
      id: PAGE,
      type: 'page',
      content: BLOCKS,
      properties: { title: [['Fixture page']] },
    })
    // The page repeats in both chunks; it is kept once, with the blocks of both chunks.
    expect(Object.keys(loaded.recordMap.block!).sort()).toEqual([PAGE, ...BLOCKS].sort())
    expect(loaded.recordMap.block![BLOCKS[0]]).toMatchObject({
      type: 'text',
      properties: { title: [['Hello '], ['bold', [['b']]]] },
    })
    expect(Object.keys(loaded.recordMap)).toEqual(['block', 'notion_user', 'space', 'discussion', 'comment'])
    expect(loaded.recordMap.comment).toMatchObject({
      'c1c1c1c1-0000-4000-8000-000000000030': { text: [['Looks good']] },
    })
  })

  it('stops after the chunk limit and says the page is incomplete', async () => {
    pageTab()
    const loaded = await (await activeNotionTab()).client.loadPage(PAGE, { maxChunks: 1 })
    expect(loaded.complete).toBe(false)
    expect(Object.keys(loaded.recordMap.block!)).toHaveLength(3)
    pageTab()
    expect((await (await activeNotionTab()).client.loadPage(PAGE, { maxChunks: 0 })).complete).toBe(false)
  })

  it('accepts page ids without dashes or in uppercase', async () => {
    for (const id of [PAGE.replace(/-/g, ''), PAGE.toUpperCase()]) {
      const tab = pageTab()
      const loaded = await (await activeNotionTab()).client.loadPage(id)
      expect(loaded.page.id).toBe(PAGE)
      expect(tab.sent[0].body.page).toEqual({ id: PAGE })
    }
  })

  it('refuses an id that is not a Notion id, without asking Notion', async () => {
    const tab = pageTab()
    const err = await notionError((await activeNotionTab()).client.loadPage('Q4 Roadmap'))
    expect([err.code, err.message]).toEqual(['notion_error', 'Not a Notion id: Q4 Roadmap'])
    expect(tab.sent).toEqual([])
  })

  it('treats a page in the trash as unavailable', async () => {
    const chunk = fixture('load-page-chunk-0') as { recordMap: { block: Record<string, { value: { value: object } }> } }
    chunk.recordMap.block[PAGE].value.value = { ...chunk.recordMap.block[PAGE].value.value, alive: false }
    new FakeNotionTab(PAGE_URL).respond('loadPageChunk', 200, chunk).install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual(['no_access', 'The Notion page or block is in the trash.'])
  })

  it('treats a page missing from the response as no access', async () => {
    new FakeNotionTab(PAGE_URL).respond('loadPageChunk', 200, fixture('empty-record-map')).install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual([
      'no_access',
      "The Notion page doesn't exist, or the signed-in Notion account has no access to it.",
    ])
  })

  it('treats a page missing from the response as signed out when no Notion user is signed in', async () => {
    const tab = new FakeNotionTab(PAGE_URL, 'notion_browser_id=b')
      .respond('loadPageChunk', 200, fixture('empty-record-map'))
      .install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual([
      'signed_out',
      'Not signed in to Notion in this tab. Sign in to Notion and try again.',
    ])
    expect(tab.sent[0].headers).toEqual({ 'content-type': 'application/json' })
  })
})

describe('Notion errors', () => {
  async function failWith(status: number, json: unknown): Promise<NotionError> {
    new FakeNotionTab(PAGE_URL).respond('loadPageChunk', status, json).install()
    return notionError((await activeNotionTab()).client.loadPage(PAGE))
  }

  it('maps an authentication error to signed out', async () => {
    expect((await failWith(401, fixture('error-unauthorized'))).code).toBe('signed_out')
  })

  it('maps a permission error to no access', async () => {
    expect((await failWith(403, {})).code).toBe('no_access')
  })

  it('passes on Notion’s explanation of other errors', async () => {
    const err = await failWith(400, fixture('error-validation'))
    expect([err.code, err.message]).toEqual([
      'notion_error',
      'Notion returned an error (400 ValidationError): Invalid input.',
    ])
    expect((await failWith(415, fixture('error-unsupported-media-type'))).message).toBe(
      'Notion returned an error (415 UnsupportedMediaTypeError): Incorrect content type.',
    )
  })

  it('treats a success that is not a JSON object as a Notion error', async () => {
    new FakeNotionTab(PAGE_URL).respondText('saveTransactionsFanout', 200, '<html>Sign in</html>').install()
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [], 'edit'))
    expect([err.code, err.message]).toEqual(['notion_error', 'Notion returned an unexpected response (200).'])
  })

  it('handles errors that are not JSON', async () => {
    new FakeNotionTab(PAGE_URL).respondText('loadPageChunk', 502, '<html>Bad gateway</html>').install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual(['notion_error', 'Notion returned an error (502): no details'])
  })
})

describe('loading records', () => {
  it('asks for the latest version of each record', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, fixture('sync-record-values'))
      .install()
    const records = await (
      await activeNotionTab()
    ).client.getRecords([{ table: 'block', id: BLOCKS[0], spaceId: SPACE }])
    expect(tab.sent[0].body).toEqual({
      requests: [{ pointer: { table: 'block', id: BLOCKS[0], spaceId: SPACE }, version: -1 }],
    })
    expect(records.block![BLOCKS[0]]).toMatchObject({ id: BLOCKS[0], version: 8, type: 'text' })
  })

  it('asks Notion nothing for no records', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    expect(await (await activeNotionTab()).client.getRecords([])).toEqual({})
    expect(tab.sent).toEqual([])
  })

  it('names the workspace when only some pointers do', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .respond('syncRecordValuesMain', 200, fixture('sync-record-values'))
      .install()
    await (
      await activeNotionTab()
    ).client.getRecords([
      { table: 'block', id: BLOCKS[0], spaceId: SPACE },
      { table: 'block', id: BLOCKS[0] },
    ])
    expect(tab.sent[0].headers['x-notion-space-id']).toBe(SPACE)
  })

  it('treats a record in the trash as unavailable', async () => {
    const sync = fixture('sync-record-values') as { recordMap: { block: Record<string, { value: { value: object } }> } }
    sync.recordMap.block[BLOCKS[0]].value.value = { ...sync.recordMap.block[BLOCKS[0]].value.value, alive: false }
    new FakeNotionTab(PAGE_URL).respond('syncRecordValuesMain', 200, sync).install()
    const err = await notionError((await activeNotionTab()).client.getRecords([{ table: 'block', id: BLOCKS[0] }]))
    expect([err.code, err.message]).toEqual(['no_access', 'The Notion page or block is in the trash.'])
  })

  it('treats a record missing from the response as no access', async () => {
    new FakeNotionTab(PAGE_URL).respond('syncRecordValuesMain', 200, fixture('sync-record-values')).install()
    const err = await notionError(
      (await activeNotionTab()).client.getRecords([
        { table: 'block', id: BLOCKS[0] },
        { table: 'block', id: BLOCKS[1] },
      ]),
    )
    expect(err.code).toBe('no_access')
  })
})

describe('submitting a transaction', () => {
  const rename: Operation = {
    pointer: { table: 'block', id: PAGE, spaceId: SPACE },
    path: ['properties'],
    command: 'updateBlockPropertyValue',
    args: { primitiveOp: { command: 'update', args: { title: [['Renamed']] } } },
  }

  it('sends the operations as one transaction in the page’s workspace', async () => {
    const tab = new FakeNotionTab(PAGE_URL).respond('saveTransactionsFanout', 200, {}).install()
    await (await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page')

    expect(tab.sent[0].url).toBe('https://app.notion.com/api/v3/saveTransactionsFanout')
    expect(tab.sent[0].headers['x-notion-space-id']).toBe(SPACE)
    const body = tab.sent[0].body as { requestId: string; transactions: { id: string }[] }
    expect(body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      transactions: [
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          spaceId: SPACE,
          debug: { userAction: 'rename page' },
          operations: [rename],
        },
      ],
    })
    expect(body.transactions[0].id).not.toBe(body.requestId)
  })

  it('sends record ids in Notion’s form and names the workspace on each pointer', async () => {
    const tab = new FakeNotionTab(PAGE_URL).respond('saveTransactionsFanout', 200, {}).install()
    const op: Operation = { ...rename, pointer: { table: 'block', id: PAGE.replace(/-/g, '').toUpperCase() } }
    await (await activeNotionTab()).client.submitTransaction(SPACE, [op], 'rename page')
    const body = tab.sent[0].body as { transactions: { operations: Operation[] }[] }
    expect(body.transactions[0].operations).toEqual([rename])
  })

  it('sends workspace ids in Notion’s form and refuses a bad one before sending', async () => {
    const tab = new FakeNotionTab(PAGE_URL).respond('saveTransactionsFanout', 200, {}).install()
    const { client } = await activeNotionTab()
    const op: Operation = { ...rename, pointer: { table: 'block', id: PAGE, spaceId: SPACE.toUpperCase() } }
    await client.submitTransaction(SPACE.replace(/-/g, ''), [op], 'rename page')
    const body = tab.sent[0].body as { transactions: { spaceId: string; operations: Operation[] }[] }
    expect(body.transactions[0].spaceId).toBe(SPACE)
    expect(body.transactions[0].operations).toEqual([rename])
    expect(tab.sent[0].headers['x-notion-space-id']).toBe(SPACE)

    const err = await notionError(client.submitTransaction('space\nX-Evil: 1', [rename], 'rename page'))
    expect(err.code).toBe('notion_error')
    await expect(client.getRecords([{ table: 'block', id: PAGE, spaceId: 'not a space' }])).rejects.toThrow(
      'Not a Notion id: not a space',
    )
    expect(tab.sent).toHaveLength(1)
  })

  it('refuses an operation on an id that is not a Notion id, without asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    const op: Operation = { ...rename, pointer: { table: 'block', id: 'Q4 Roadmap' } }
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [op], 'rename page'))
    expect([err.code, err.message]).toEqual(['notion_error', 'Not a Notion id: Q4 Roadmap'])
    expect(tab.sent).toEqual([])
  })

  it('reports a rejected transaction with Notion’s explanation', async () => {
    new FakeNotionTab(PAGE_URL)
      .respond('saveTransactionsFanout', 400, {
        ...(fixture('error-validation') as object),
        debugMessage: 'Block property value updates must use high-level property operations.',
      })
      .install()
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page'))
    expect(err.message).toBe(
      'Notion returned an error (400 ValidationError): Block property value updates must use high-level property operations.',
    )
  })

  it('says the outcome is unknown when Notion did not answer, so the change is not retried blindly', async () => {
    for (const fail of [
      (tab: FakeNotionTab) => (tab.networkDown = true),
      (tab: FakeNotionTab) => (tab.closed = true),
    ]) {
      const tab = new FakeNotionTab(PAGE_URL).respond('saveTransactionsFanout', 200, {}).install()
      const { client } = await activeNotionTab()
      fail(tab)
      const err = await notionError(client.submitTransaction(SPACE, [rename], 'rename page'))
      expect([err.code, err.message]).toEqual([
        'outcome_unknown',
        'Notion did not answer, so the change may or may not have been saved. Read the page again before retrying.',
      ])
    }
  })

  it('says the outcome is unknown when Notion answers a change with a server error', async () => {
    new FakeNotionTab(PAGE_URL).respondText('saveTransactionsFanout', 504, '<html>Gateway timeout</html>').install()
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page'))
    expect(err.code).toBe('outcome_unknown')
  })

  it('reports a server error on a read as a Notion error', async () => {
    new FakeNotionTab(PAGE_URL).respondText('loadPageChunk', 503, 'busy').install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual(['notion_error', 'Notion returned an error (503): no details'])
  })

  it('says nothing was saved when the tab left Notion before the change was sent', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    const { client } = await activeNotionTab()
    tab.pageUrl = 'https://mail.example.com/inbox'
    expect((await notionError(client.submitTransaction(SPACE, [rename], 'rename page'))).code).toBe('no_notion_tab')
  })

  it('never writes CRDT data', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    const { client } = await activeNotionTab()
    const pointer = { table: 'block' as const, id: BLOCKS[0] }
    for (const op of [
      { pointer, path: ['crdt_data', 'title'], command: 'update', args: {} },
      { pointer, path: ['properties', 'crdt_data'], command: 'update', args: {} },
      { pointer, path: [], command: 'update', args: { crdt_data: {} } },
      { pointer, path: [], command: 'set', args: { id: BLOCKS[0], format: { crdt_data: {} } } },
    ] satisfies Operation[]) {
      const err = await notionError(client.submitTransaction(SPACE, [op], 'edit'))
      expect([err.code, err.message]).toEqual(['notion_error', 'Operations must not write crdt_data.'])
    }
    expect(tab.sent).toEqual([])
  })
})

describe('record maps', () => {
  it('unwrap both the current and the older record shape and drop entries without a record', () => {
    const record = { id: 'b1', version: 1, type: 'text' }
    expect(
      normalizeRecordMap({
        __version__: 3,
        block: {
          b1: { spaceId: SPACE, value: { role: 'editor', value: record } },
          b2: { role: 'reader', value: { ...record, id: 'b2' } },
          b3: { spaceId: SPACE, value: { role: 'none' } },
        },
      }),
    ).toEqual({ block: { b1: record, b2: { ...record, id: 'b2' } } })
  })
})

describe('when Notion is limiting requests', () => {
  /** A client whose waits are recorded and end at once. */
  function client(waits: number[] = []): NotionClient {
    const wait: Wait = async (ms) => void waits.push(ms)
    return new NotionClient(tabTransport(7), { wait })
  }
  const page = { id: PAGE, type: 'page', properties: { title: [['Fixture page']] } }
  const rename: Operation = {
    pointer: { table: 'block', id: PAGE, spaceId: SPACE },
    path: ['properties'],
    command: 'updateBlockPropertyValue',
    args: { primitiveOp: { command: 'update', args: { title: [['Renamed']] } } },
  }

  it('[UC-NOTION-001-S08] waits and tries again, then reads the page', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 2).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const waits: number[] = []
    expect((await client(waits).loadPage(PAGE)).page.id).toBe(PAGE)
    expect(waits).toEqual([1_000, 2_000])
    expect(tab.sent).toHaveLength(3)
  })

  it('[UC-NOTION-001-S08] backs off for 1 s, 2 s, then 4 s, then stops and says to have the user wait', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 10).install()
    const waits: number[] = []
    const err = await notionError(client(waits).loadPage(PAGE))
    expect([err.code, err.message, err.unanswered]).toEqual(['rate_limited', RATE_LIMITED, false])
    expect(waits).toEqual([1_000, 2_000, 4_000])
    expect(tab.sent).toHaveLength(4)
  })

  it('never waits less than the backoff, whatever Retry-After says', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .limit('loadPageChunk', 1, { 'retry-after': '0' })
      .limit('loadPageChunk', 1, { 'retry-after': new Date(Date.now() - 60_000).toUTCString() })
      .limit('loadPageChunk', 1, { 'retry-after': '1.5' })
      .install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const waits: number[] = []
    await client(waits).loadPage(PAGE)
    expect(waits).toEqual([1_000, 2_000, 4_000])
  })

  it('gives up once the client waited too long in all, across its requests', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .limit('loadPageChunk', 2, { 'retry-after': '10' })
      .limit('syncRecordValuesMain', 2, { 'retry-after': '10' })
      .install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const waits: number[] = []
    const notion = client(waits)
    await notion.loadPage(PAGE)
    // 20 s so far: one more 10 s wait fits in the 30 s, the one after it doesn't.
    const err = await notionError(notion.getRecords([{ table: 'block', id: PAGE }]))
    expect(err.code).toBe('rate_limited')
    expect(waits).toEqual([10_000, 10_000, 10_000])
    // Having given up, the client sends nothing more.
    const sent = tab.sent.length
    expect((await notionError(notion.loadPage(PAGE))).code).toBe('rate_limited')
    expect(tab.sent).toHaveLength(sent)
  })

  it('waits as long as Retry-After says, in seconds or until a date', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
      .limit('syncRecordValuesMain', 1, { 'retry-after': '3' })
      // A whole second, as an HTTP date has no milliseconds, well past the 2 s backoff.
      .limit('syncRecordValuesMain', 1, {
        'retry-after': new Date(Math.floor(Date.now() / 1_000) * 1_000 + 10_000).toUTCString(),
      })
      .install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const waits: number[] = []
    const records = await client(waits).getRecords([{ table: 'block', id: PAGE }])
    expect(records.block?.[PAGE]?.id).toBe(PAGE)
    expect(waits[0]).toBe(3_000)
    expect(waits[1]).toBeGreaterThan(5_000)
    expect(waits[1]).toBeLessThanOrEqual(10_000)
  })

  it('gives up at once when Notion asks for a longer wait than a tool should hold', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, { 'retry-after': '120' }).install()
    const waits: number[] = []
    expect((await notionError(client(waits).loadPage(PAGE))).code).toBe('rate_limited')
    expect([waits, tab.sent.length]).toEqual([[], 1])
  })

  it('treats an overloaded answer to a read like a rate limit', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, {}, 529).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    expect((await client().loadPage(PAGE)).page.id).toBe(PAGE)
    expect(tab.sent).toHaveLength(2)
  })

  it('[UC-NOTION-002-S11] sends a change again when Notion refused it for coming too fast, and it is applied once', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('saveTransactionsFanout', 1).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    await client().submitTransaction(SPACE, [rename], 'rename page')
    expect(tab.sent).toHaveLength(2)
    expect(tab.workspace.transactions).toHaveLength(1)
    expect(tab.workspace.records.get(PAGE)?.properties).toEqual({ title: [['Renamed']] })
  })

  it('does not send a change again after an overloaded answer, which may come after it was applied', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('saveTransactionsFanout', 1, {}, 529).install()
    const waits: number[] = []
    const err = await notionError(client(waits).submitTransaction(SPACE, [rename], 'rename page'))
    expect(err.code).toBe('outcome_unknown')
    expect([waits, tab.sent.length]).toEqual([[], 1])
  })

  it('[UC-NOTION-002-S11] says a change was not done when Notion keeps refusing it', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('saveTransactionsFanout', 10).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const err = await notionError(client().submitTransaction(SPACE, [rename], 'rename page'))
    expect([err.code, err.message]).toEqual(['rate_limited', RATE_LIMITED])
    expect(tab.sent).toHaveLength(4)
    expect(tab.workspace.transactions).toEqual([])
    expect(tab.workspace.records.get(PAGE)?.properties).toEqual({ title: [['Fixture page']] })
  })

  it('holds the client’s other requests while one backs off', async () => {
    let release = () => {}
    const waits: number[] = []
    const wait: Wait = (ms) => {
      waits.push(ms)
      return new Promise((resolve) => (release = resolve))
    }
    const tab = new FakeNotionTab(PAGE_URL).limit('syncRecordValuesMain', 1).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const notion = new NotionClient(tabTransport(7), { wait })
    const first = notion.getRecords([{ table: 'block', id: PAGE }])
    while (waits.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const second = notion.getRecords([{ table: 'block', id: PAGE }])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tab.sent).toHaveLength(1)
    release()
    await Promise.all([first, second])
    expect(tab.sent).toHaveLength(3)
  })

  it('stops waiting as soon as the user stops, and sends nothing more', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, { 'retry-after': '20' }).install()
    const stop = new AbortController()
    const { client: notion } = await activeNotionTab(stop.signal)
    const started = Date.now()
    const loading = notion.loadPage(PAGE)
    // Stop once Notion refused the first request, so the client is in its (real) 20 s wait.
    while (tab.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    await new Promise((resolve) => setTimeout(resolve, 5))
    stop.abort()
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(tab.sent).toHaveLength(1)
  })

  it('does not back off again for a request answered after the client gave up', async () => {
    // A slow request is still out when another one runs out of tries; then Notion refuses it too.
    const limited: NotionResponse = { status: 429, json: {}, signedIn: true }
    let answerSlow: (res: NotionResponse) => void = () => {}
    const sent: string[] = []
    const send: NotionTransport = (endpoint) => {
      sent.push(endpoint)
      if (endpoint === 'syncRecordValuesMain') return new Promise((resolve) => (answerSlow = resolve))
      return Promise.resolve(limited)
    }
    const notion = new NotionClient(send, { wait: async () => {} })
    const slow = notionError(notion.getRecords([{ table: 'block', id: PAGE }]))
    expect((await notionError(notion.loadPage(PAGE))).code).toBe('rate_limited')
    answerSlow(limited)
    expect((await slow).code).toBe('rate_limited')
    expect(sent.filter((e) => e === 'syncRecordValuesMain')).toHaveLength(1)
  })

  it('stops backing off when another request gave up meanwhile', async () => {
    // Notion's answers are given by hand, one call at a time.
    const limited: NotionResponse = { status: 429, json: {}, signedIn: true }
    const record = { spaceId: SPACE, value: { role: 'editor', value: { id: PAGE, version: 1, alive: true } } }
    const found: NotionResponse = { status: 200, json: { recordMap: { block: { [PAGE]: record } } }, signedIn: true }
    const calls: { endpoint: string; answer?: (res: NotionResponse) => void }[] = []
    const send: NotionTransport = (endpoint) => new Promise((answer) => calls.push({ endpoint, answer }))
    /** Answers the next unanswered call to `endpoint`, once it has gone out. */
    const answer = async (endpoint: string, res: NotionResponse) => {
      for (;;) {
        const call = calls.find((c) => c.endpoint === endpoint && c.answer)
        if (call) {
          const reply = call.answer!
          call.answer = undefined
          return reply(res)
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    let holdWait = false
    let endWait = () => {}
    let waiting = false
    const wait: Wait = () => {
      if (!holdWait) return Promise.resolve()
      waiting = true
      return new Promise((resolve) => (endWait = resolve))
    }
    const notion = new NotionClient(send, { wait })
    const read = () => notion.getRecords([{ table: 'block', id: PAGE }])
    // A slow search is refused each time it goes out; meanwhile reads back off and get through.
    const search = notionError(notion.search(SPACE, 'x', 10))
    for (let round = 0; round < 3; round++) {
      const reading = read()
      await answer('syncRecordValuesMain', limited) // the read backs off
      await answer('search', limited) // the search holds
      await answer('syncRecordValuesMain', found)
      await reading
    }
    // A fourth read backs off; while it waits, the search is refused a fourth time and gives up.
    holdWait = true
    const reading = notionError(read())
    await answer('syncRecordValuesMain', limited)
    while (!waiting) await new Promise((resolve) => setTimeout(resolve, 1))
    await answer('search', limited)
    expect((await search).code).toBe('rate_limited')
    const before = calls.length
    endWait()
    expect((await reading).code).toBe('rate_limited')
    expect(calls).toHaveLength(before)
  })

  it('stops a request held behind another one as soon as the user stops', async () => {
    const limited: NotionResponse = { status: 429, json: {}, signedIn: true }
    const sent: string[] = []
    // Notion refuses the first request, and doesn't answer its resend yet.
    const send: NotionTransport = (endpoint) => {
      sent.push(endpoint)
      return sent.length === 1 ? Promise.resolve(limited) : new Promise(() => {})
    }
    const stop = new AbortController()
    const notion = new NotionClient(send, { signal: stop.signal, wait: async () => {} })
    void notion.loadPage(PAGE).catch(() => {})
    while (sent.length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
    const held = notion.getRecords([{ table: 'block', id: PAGE }])
    stop.abort()
    await expect(held).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toEqual(['loadPageChunk', 'loadPageChunk'])
  })

  it('backs off longer each time within a tool call, also when a burst is refused again', async () => {
    // Two reads in a row, each refused once: the second backoff waits longer than the first.
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1).limit('syncRecordValuesMain', 1).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const waits: number[] = []
    const notion = client(waits)
    await notion.loadPage(PAGE)
    await notion.getRecords([{ table: 'block', id: PAGE }])
    expect(waits).toEqual([1_000, 2_000])
  })

  it('backs off once for a burst Notion refuses together, and the others send after it is answered', async () => {
    // 400 records go as 4 batches at once; Notion refuses all 4, and the first one's resend too.
    const ids = Array.from({ length: 400 }, (_, i) => `1c1c1c1c-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const tab = new FakeNotionTab(PAGE_URL).limit('syncRecordValuesMain', 5, { 'retry-after': '10' }).install()
    tab.workspace = new FakeWorkspace(
      ids.map((id) => ({ id, type: 'page' })),
      SPACE,
    )
    const waits: number[] = []
    const records = await client(waits).findRecords(ids.map((id) => ({ table: 'block', id })))
    expect(Object.keys(records.block ?? {})).toHaveLength(400)
    // One request backs off, its waits counted once; the other three hold until it is answered.
    expect(waits).toEqual([10_000, 10_000])
    expect(tab.sent).toHaveLength(9)
  })
})
