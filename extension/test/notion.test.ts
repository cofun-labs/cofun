// The extension's Notion API client (extension/src/notion/), against a fake Notion tab that serves
// sanitized fixtures of Notion's responses.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUSY_UNKNOWN,
  COOLDOWN_MAX_MS,
  LIMITED_STOP,
  NotionClient,
  NotionCooldown,
  coolingStop,
  limitedStop,
  waitText,
  NOT_SENT,
  NotionError,
  type CooldownStore,
  RATE_LIMITED,
  UNEXPECTED_STOP,
  UNKNOWN_STOP,
  fieldsOf,
  normalizeRecordMap,
  pointerIn,
  textList,
  type Operation,
} from '../src/notion/api'
import { pageIdFromUrl } from '../src/notion/hosts'
import { COOLDOWN_KEY, activeNotionTab, chromeCooldownStore, notionCooldown, tabTransport } from '../src/notion/tab'
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
      expect([err.code, err.message]).toEqual([
        'no_notion_tab',
        expect.stringContaining('The current tab is not a Notion page'),
      ])
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
    expect(err.message).toMatch(/^Notico is not allowed to access this Notion site\./)
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

  it('refuses an id that is not a Notion id, without asking Notion or stopping the question', async () => {
    const tab = pageTab()
    const err = await (await activeNotionTab()).client.loadPage('Q4 Roadmap').catch((e: unknown) => e)
    // The model gave the id and can give another one.
    expect(err).not.toBeInstanceOf(NotionError)
    expect((err as Error).message).toBe('Not a Notion id: Q4 Roadmap')
    expect(tab.sent).toEqual([])
  })

  it('treats a page in the trash as unavailable', async () => {
    const chunk = fixture('load-page-chunk-0') as { recordMap: { block: Record<string, { value: { value: object } }> } }
    chunk.recordMap.block[PAGE].value.value = { ...chunk.recordMap.block[PAGE].value.value, alive: false }
    new FakeNotionTab(PAGE_URL).respond('loadPageChunk', 200, chunk).install()
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.message]).toEqual(['in_trash', 'The Notion page or block is in the trash.'])
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
    expect([err.code, err.message]).toEqual(['in_trash', 'The Notion page or block is in the trash.'])
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

    await expect(client.submitTransaction('space\nX-Evil: 1', [rename], 'rename page')).rejects.toThrow(
      'Not a Notion id: space',
    )
    await expect(client.getRecords([{ table: 'block', id: PAGE, spaceId: 'not a space' }])).rejects.toThrow(
      'Not a Notion id: not a space',
    )
    expect(tab.sent).toHaveLength(1)
  })

  it('refuses an operation on an id that is not a Notion id, without asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    const op: Operation = { ...rename, pointer: { table: 'block', id: 'Q4 Roadmap' } }
    await expect((await activeNotionTab()).client.submitTransaction(SPACE, [op], 'rename page')).rejects.toThrow(
      'Not a Notion id: Q4 Roadmap',
    )
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

  it('read a field that is not what is expected as missing, and pass on every other field as it came', () => {
    const wrap = (value: unknown) => ({ spaceId: SPACE, value: { role: 'editor', value } })
    const map = normalizeRecordMap({
      block: {
        ok: wrap({ id: 'ok', version: 7, type: 'text', alive: true, content: ['a', 'b'], extra: { kept: [1, null] } }),
        odd: wrap({
          id: 'odd',
          version: '7',
          type: 5,
          alive: 'yes',
          space_id: 9,
          parent_id: null,
          parent_table: ['block'],
          properties: 'none',
          format: [],
          content: ['a', 7, null, 'b'],
        }),
        text: wrap({ id: 'text', version: 1, type: 'text', content: 'ab' }),
        bare: wrap({ id: 'bare' }),
        list: wrap(['id']),
        idless: wrap({ version: 1, type: 'text' }),
        nothing: null,
      },
      collection: { c: wrap({ id: 'c', version: 2, schema: 'kept as it is', alive: 0 }) },
      // A table this client reads nothing from, and what is not a table.
      custom_emoji: { e: wrap({ id: 'e', version: 1 }) },
      space: 'none',
      team: ['t'],
    })
    expect(map).toEqual({
      block: {
        ok: { id: 'ok', version: 7, type: 'text', alive: true, content: ['a', 'b'], extra: { kept: [1, null] } },
        // No type reads as none; a version that is not a number is left out like the other fields.
        odd: { id: 'odd', type: '', content: ['a', 'b'] },
        text: { id: 'text', version: 1, type: 'text' },
        bare: { id: 'bare', type: '' },
      },
      collection: { c: { id: 'c', version: 2, schema: 'kept as it is' } },
    })
  })
})

describe('fields inside a record', () => {
  it('are read loosely: a pointer part that is not text is missing, and a list keeps its texts', () => {
    const format = {
      collection_pointer: { id: 'c1', spaceId: 's1', table: 'collection' },
      alias_pointer: { id: 5, spaceId: ['s'] },
      copy: 'c1',
    }
    expect(pointerIn(format, 'collection_pointer')).toEqual({ id: 'c1', spaceId: 's1' })
    expect(pointerIn(format, 'alias_pointer')).toEqual({})
    expect(pointerIn(format, 'copy')).toBeUndefined()
    expect(pointerIn(format, 'missing')).toBeUndefined()
    expect(pointerIn(undefined, 'collection_pointer')).toBeUndefined()

    expect(textList(['a', 5, null, 'b', ['c']])).toEqual(['a', 'b'])
    for (const value of [undefined, null, 'ab', { 0: 'a' }, 7]) expect(textList(value)).toEqual([])

    expect(fieldsOf({ table_properties: [] })).toEqual({ table_properties: [] })
    for (const value of [undefined, null, 'ab', ['a'], 7]) expect(fieldsOf(value)).toBeUndefined()
  })
})

describe('answers this client reads loosely', () => {
  const client = async () => (await activeNotionTab()).client
  const database = { collectionId: PAGE, viewId: PAGE, spaceId: SPACE }

  it('lists no rows when queryCollection answers in another shape', async () => {
    for (const answer of [{}, { result: 'none' }, { result: { reducerResults: [] } }, { result: null, recordMap: 5 }]) {
      new FakeNotionTab(PAGE_URL).respond('queryCollection', 200, answer).install()
      const { collectionId, viewId, spaceId } = database
      expect(await (await client()).queryCollection(collectionId, viewId, spaceId, 10)).toEqual({
        rowIds: [],
        hasMore: false,
        recordMap: {},
      })
    }
    const group = { blockIds: ['r1', 5, null, 'r2'], hasMore: 'yes' }
    new FakeNotionTab(PAGE_URL)
      .respond('queryCollection', 200, { result: { reducerResults: { collection_group_results: group } } })
      .install()
    const rows = await (await client()).queryCollection(database.collectionId, database.viewId, database.spaceId, 10)
    expect([rows.rowIds, rows.hasMore]).toEqual([['r1', 'r2'], false])
  })

  it('finds nothing when search answers no list, and keeps only hits with an id', async () => {
    new FakeNotionTab(PAGE_URL).respond('search', 200, { results: 'none', total: 'many' }).install()
    expect(await (await client()).search(SPACE, 'x', 5)).toEqual({ results: [], total: 0, recordMap: {} })
    const hits = [
      {
        id: 'a',
        score: 1.5,
        highlight: { text: 'found', title: 7, other: 'kept' },
        highlightBlockId: 9,
        spaceId: SPACE,
      },
      { id: 5 },
      null,
      'b',
      { id: 'c', highlight: 'none', score: 'high' },
    ]
    new FakeNotionTab(PAGE_URL).respond('search', 200, { results: hits, total: 2 }).install()
    expect(await (await client()).search(SPACE, 'x', 5)).toEqual({
      // What the schema doesn't name passes through, on the hit and inside its highlight.
      results: [{ id: 'a', score: 1.5, highlight: { text: 'found', other: 'kept' }, spaceId: SPACE }, { id: 'c' }],
      total: 2,
      recordMap: {},
    })
  })
})

describe('when Notion turns requests away', () => {
  const page = { id: PAGE, type: 'page', properties: { title: [['Fixture page']] } }
  const rename: Operation = {
    pointer: { table: 'block', id: PAGE, spaceId: SPACE },
    path: ['properties'],
    command: 'updateBlockPropertyValue',
    args: { primitiveOp: { command: 'update', args: { title: [['Renamed']] } } },
  }

  it('stops at the first refusal of a read, says so, and sends nothing more', async () => {
    for (const status of [429, 529]) {
      const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, status).install()
      tab.workspace = new FakeWorkspace([page], SPACE)
      const { client } = await activeNotionTab()
      const err = await notionError(client.loadPage(PAGE))
      expect([err.code, err.message, err.stopsQuestion]).toEqual(['rate_limited', RATE_LIMITED, LIMITED_STOP])
      // Not retried, and the same client sends nothing more, though Notion would answer now.
      const later = await notionError(client.getRecords([{ table: 'block', id: PAGE }]))
      expect([later.code, later.message, later.stopsQuestion]).toEqual(['rate_limited', NOT_SENT, LIMITED_STOP])
      expect(tab.sent).toHaveLength(1)
    }
  })

  it('starts no wait when Notion does not say how long: the next client sends', async () => {
    for (const retryAfter of [undefined, 'soon', '0']) {
      const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, 429, retryAfter).install()
      tab.workspace = new FakeWorkspace([page], SPACE)
      const { client } = await activeNotionTab()
      const err = await notionError(client.loadPage(PAGE))
      expect([err.code, err.stopsQuestion]).toEqual(['rate_limited', LIMITED_STOP])
      // The client that was turned away still sends nothing more.
      const later = await notionError(client.getRecords([{ table: 'block', id: PAGE }]))
      expect([later.message, later.stopsQuestion]).toEqual([NOT_SENT, LIMITED_STOP])
      expect(tab.sent).toHaveLength(1)
      // Nothing is kept for the browser's side panels either.
      expect(tab.storage.values[COOLDOWN_KEY] ?? 0).toBe(0)
      // Another client, as the next question would make, sends at once.
      await (await activeNotionTab()).client.loadPage(PAGE)
      expect(tab.sent).toHaveLength(2)
    }
  })

  it('keeps every client from sending until the wait Notion asked for is over', async () => {
    let now = Date.now()
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, 429, '120').install()
    notionCooldown.now = () => now
    tab.workspace = new FakeWorkspace([page], SPACE)
    const first = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    // The user is told the wait Notion asked for.
    expect(first.stopsQuestion).toContain('Wait 2 minutes, then ask again.')
    // Another client, as the next question would make: nothing is sent while the wait is on.
    now += 119_000
    const waiting = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([waiting.code, waiting.message, waiting.stopsQuestion]).toEqual([
      'rate_limited',
      NOT_SENT,
      coolingStop(1000),
    ])
    expect(tab.sent).toHaveLength(1)
    now += 1000
    await (await activeNotionTab()).client.loadPage(PAGE)
    expect(tab.sent).toHaveLength(2)
  })

  it('waits as long as Retry-After asks, up to the longest wait, and not at all when it says nothing usable', () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    // 0 is no wait: only what Notion asks for in a way that is understood starts one.
    const waits: [string | undefined, number][] = [
      ['120', 120_000],
      ['5', 5000],
      ['0', 0],
      ['Tue, 10 Nov 2026 08:02:00 GMT', 120_000],
      ['Tue, 10 Nov 2026 07:00:00 GMT', 0],
      ['-1', 0],
      ['1.5', 0],
      ['99999', COOLDOWN_MAX_MS],
      ['9'.repeat(400), COOLDOWN_MAX_MS],
      [undefined, 0],
      ['soon', 0],
      // Not seconds or an HTTP date, though JavaScript's own date parsing would make a date of each.
      ['Dec 2026', 0],
      ['retry 2040', 0],
      ['2026-11-10T08:05:00Z', 0],
      ['Tue, 10 Nov 2026 08:05:00 PST', 0],
      ['Tue, 10 Nov 2026 08:05:00 +0000', 0],
      ['120, 120', 0],
    ]
    for (const [retryAfter, ms] of waits) {
      const cooldown = new NotionCooldown(() => now)
      cooldown.start(retryAfter)
      expect([retryAfter, cooldown.left()]).toEqual([retryAfter, ms])
    }
    // A shorter wait never cuts a longer one short.
    const cooldown = new NotionCooldown(() => now)
    cooldown.start('120')
    cooldown.start('70')
    expect(cooldown.left()).toBe(120_000)
  })

  it('words a wait the same way in both messages, rounded up', () => {
    const texts: [number, string][] = [
      [1, '1 second'],
      [30_000, '30 seconds'],
      [59_000, '59 seconds'],
      [59_001, 'a minute'],
      [60_000, 'a minute'],
      [60_001, '2 minutes'],
      [75_000, '2 minutes'],
      [5 * 60_000, '5 minutes'],
      [COOLDOWN_MAX_MS, '10 minutes'],
    ]
    for (const [ms, text] of texts) {
      expect([ms, waitText(ms)]).toEqual([ms, text])
      expect(limitedStop(ms)).toContain(`Wait ${text}, then ask again.`)
      expect(coolingStop(ms)).toContain(`Ask again in ${text}.`)
    }
    expect(waitText(0)).toBe('1 second')
    // Without a wait Notion asked for, a minute is the advice.
    expect([LIMITED_STOP, limitedStop(0)]).toEqual([limitedStop(60_000), limitedStop(60_000)])
  })

  it('tells a request the same client makes after a refusal the wait that is left, not a minute', async () => {
    let now = Date.now()
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, 429, '120').install()
    notionCooldown.now = () => now
    const { client } = await activeNotionTab()
    const first = await notionError(client.loadPage(PAGE))
    expect(first.stopsQuestion).toBe(limitedStop(120_000))
    // A request of the same tool call, such as one of a parallel batch that hadn't left yet.
    const later = await notionError(client.getRecords([{ table: 'block', id: PAGE }]))
    expect([later.message, later.stopsQuestion]).toEqual([NOT_SENT, limitedStop(120_000)])
    now += 90_000
    const last = await notionError(client.getRecords([{ table: 'block', id: PAGE }]))
    expect(last.stopsQuestion).toBe(limitedStop(30_000))
    // Once the wait is over, the client still sends nothing, and names the usual wait, not none.
    now += 30_000
    const over = await notionError(client.getRecords([{ table: 'block', id: PAGE }]))
    expect(over.stopsQuestion).toBe(LIMITED_STOP)
    expect(tab.sent).toHaveLength(1)
  })

  it('never waits longer than the longest wait, even when the clock is set back', () => {
    let now = Date.parse('2026-11-10T08:00:00Z')
    const cooldown = new NotionCooldown(() => now)
    cooldown.start('600')
    now -= 60 * 60_000
    expect(cooldown.left()).toBe(COOLDOWN_MAX_MS)
    // The wait ends that long after the clock changed, not an hour later.
    now += COOLDOWN_MAX_MS - 1
    expect(cooldown.left()).toBe(1)
    now += 1
    expect(cooldown.left()).toBe(0)
  })

  it('keeps every side panel of the browser from sending during the wait, one opened later included', async () => {
    let now = Date.now()
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, 429, '120').install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    // Each side panel is a document of its own, with its own cooldown over the browser's storage.
    const openPanel = async () => {
      const cooldown = new NotionCooldown(() => now, chromeCooldownStore)
      await cooldown.ready()
      return new NotionClient(tabTransport(7), undefined, cooldown)
    }
    const [first, second] = [await openPanel(), await openPanel()]
    await notionError(first.loadPage(PAGE))
    // The panel of another Notion tab, open all along.
    const other = await notionError(second.loadPage(PAGE))
    expect([other.code, other.message, other.stopsQuestion]).toEqual(['rate_limited', NOT_SENT, coolingStop(120_000)])
    // A panel opened, or reopened, during the wait.
    now += 60_000
    const opened = await notionError((await openPanel()).loadPage(PAGE))
    expect([opened.code, opened.message, opened.stopsQuestion]).toEqual(['rate_limited', NOT_SENT, coolingStop(60_000)])
    expect(tab.sent).toHaveLength(1)
    now += 60_000
    await (await openPanel()).loadPage(PAGE)
    expect(tab.sent).toHaveLength(2)
  })

  it('cuts a kept wait that ends too far ahead to the longest wait, and ignores one that is not a time', async () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    let tab = new FakeNotionTab(PAGE_URL).install()
    // Each in a browser of its own.
    const kept = async (value: unknown) => {
      tab = new FakeNotionTab(PAGE_URL).install()
      await tab.storage.local.set({ [COOLDOWN_KEY]: value })
      const cooldown = new NotionCooldown(() => now, chromeCooldownStore)
      await cooldown.ready()
      return cooldown.left()
    }
    expect(await kept(now + 24 * 60 * 60_000)).toBe(COOLDOWN_MAX_MS)
    // Cut in the storage too, so a panel opened later doesn't start the longest wait over.
    expect(tab.storage.values[COOLDOWN_KEY]).toBe(now + COOLDOWN_MAX_MS)
    expect(await kept(now - 1)).toBe(0)
    for (const value of ['soon', null, Number.NaN, Infinity, { until: now + 1000 }]) expect(await kept(value)).toBe(0)
  })

  it('still keeps the wait in the side panel when the storage fails', async () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    const broken: CooldownStore = {
      load: () => Promise.reject(new Error('storage is broken')),
      save: () => Promise.reject(new Error('storage is broken')),
      onChange: () => {},
    }
    const cooldown = new NotionCooldown(() => now, broken)
    await cooldown.ready()
    cooldown.start('120')
    expect(cooldown.left()).toBe(120_000)
  })

  it('loads the kept wait on a later try when the first load failed', async () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    let loads = 0
    let listeners = 0
    const flaky: CooldownStore = {
      load: async () => {
        if (loads++ === 0) throw new Error('storage is busy')
        return now + 120_000
      },
      save: async () => {},
      onChange: () => void listeners++,
    }
    const cooldown = new NotionCooldown(() => now, flaky)
    await cooldown.ready()
    expect(cooldown.left()).toBe(0)
    await cooldown.ready()
    expect(cooldown.left()).toBe(120_000)
    // Loaded: not loaded again, and the store's changes are followed once.
    await cooldown.ready()
    expect([loads, listeners]).toEqual([2, 1])
  })

  it('keeps the later end when two side panels are turned away at the same moment', async () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    // A storage whose change events arrive later, as chrome.storage's do.
    let kept: unknown
    const events: number[] = []
    const listeners: ((until: unknown) => void)[] = []
    const store: CooldownStore = {
      load: async () => kept,
      save: async (until) => {
        kept = until
        events.push(until)
      },
      onChange: (listener) => void listeners.push(listener),
    }
    const openPanel = async () => {
      const cooldown = new NotionCooldown(() => now, store)
      await cooldown.ready()
      return cooldown
    }
    const [first, second] = [await openPanel(), await openPanel()]
    // Both turned away before either hears of the other: the shorter wait is saved last.
    first.start('600')
    second.start('60')
    expect(kept).toBe(now + 60_000)
    while (events.length) for (const until of events.splice(0)) for (const listener of listeners) listener(until)
    expect([first.left(), second.left()]).toEqual([COOLDOWN_MAX_MS, COOLDOWN_MAX_MS])
    // A panel opened afterwards waits as long as Notion asked.
    expect((await openPanel()).left()).toBe(COOLDOWN_MAX_MS)
  })

  it('tries again when following the storage failed', async () => {
    const now = Date.parse('2026-11-10T08:00:00Z')
    let tries = 0
    const store: CooldownStore = {
      load: async () => now + 120_000,
      save: async () => {},
      onChange: () => {
        if (tries++ === 0) throw new Error('storage is busy')
      },
    }
    const cooldown = new NotionCooldown(() => now, store)
    await cooldown.ready()
    expect(cooldown.left()).toBe(0)
    await cooldown.ready()
    expect(cooldown.left()).toBe(120_000)
  })

  it('reads the wait kept in a new browser, not the one before it', async () => {
    new FakeNotionTab(PAGE_URL).install()
    await activeNotionTab()
    const tab = new FakeNotionTab(PAGE_URL).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    await tab.storage.local.set({ [COOLDOWN_KEY]: Date.now() + 120_000 })
    const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
    expect([err.code, err.stopsQuestion]).toEqual(['rate_limited', coolingStop(120_000)])
    expect(tab.sent).toHaveLength(0)
  })

  it('a side panel opened during the wait loads it before its first request', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('loadPageChunk', 1, 429, '120').install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    await notionError((await activeNotionTab()).client.loadPage(PAGE))
    // The side panel's modules loaded anew, as in a panel that was closed and opened again.
    vi.resetModules()
    const reopened = await import('../src/notion/tab')
    const { client } = await reopened.activeNotionTab()
    const err = await client.loadPage(PAGE).then(
      () => undefined,
      (e: NotionError) => e,
    )
    expect([err?.code, err?.message, err?.stopsQuestion]).toEqual(['rate_limited', NOT_SENT, coolingStop(120_000)])
    expect(tab.sent).toHaveLength(1)
  })

  it('[UC-NOTION-002-S11] does not send a change again that Notion turned away, and nothing changes', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('saveTransactionsFanout', 1).install()
    tab.workspace = new FakeWorkspace([page], SPACE)
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page'))
    expect([err.code, err.stopsQuestion]).toEqual(['rate_limited', LIMITED_STOP])
    expect(tab.sent).toHaveLength(1)
    expect(tab.workspace.transactions).toEqual([])
  })

  it('[UC-NOTION-002-S12] says the outcome of a change is unknown when Notion is too busy, which may come after it was applied', async () => {
    const tab = new FakeNotionTab(PAGE_URL).limit('saveTransactionsFanout', 1, 529).install()
    const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page'))
    // The user is told the change may have been saved, since the question stops before the AI can say so.
    expect([err.code, err.message, err.stopsQuestion, err.mayHaveChanged]).toEqual([
      'outcome_unknown',
      BUSY_UNKNOWN,
      LIMITED_STOP,
      true,
    ])
    expect(tab.sent).toHaveLength(1)
  })

  it('reports a refusal ahead of another failure that came first in parallel lookups', async () => {
    // 200 records go as 2 batches at once: Notion fails the first and turns the second away.
    const ids = Array.from({ length: 200 }, (_, i) => `1d1d1d1d-0000-4000-8000-${String(i).padStart(12, '0')}`)
    new FakeNotionTab(PAGE_URL)
      .respondText('syncRecordValuesMain', 503, 'busy')
      .limit('syncRecordValuesMain', 1)
      .install()
    const { client } = await activeNotionTab()
    const err = await notionError(client.findRecords(ids.map((id) => ({ table: 'block', id }))))
    expect([err.code, err.stopsQuestion]).toEqual(['rate_limited', LIMITED_STOP])
  })

  it('[UC-NOTION-001-S11] stops the question on each failure that is not understood, and sends it once', async () => {
    const cases: [string, (tab: FakeNotionTab) => void, string][] = [
      [
        'server error',
        (t) => t.respondText('loadPageChunk', 503, 'busy'),
        'Notion returned an error (503): no details.',
      ],
      [
        'unexplained refusal',
        (t) => t.respond('loadPageChunk', 409, { name: 'ConflictError', message: 'Conflict' }),
        'Notion returned an error (409 ConflictError): Conflict.',
      ],
      [
        'answer that is not an object',
        (t) => t.respondText('loadPageChunk', 200, '<html></html>'),
        'Notion returned an unexpected response (200).',
      ],
      [
        'redirect while signed in',
        (t) => ((t.redirects = true), t.respond('loadPageChunk', 200, {})),
        'Notion redirected the request instead of answering it.',
      ],
      ['no network', (t) => (t.networkDown = true), 'Could not reach Notion: Failed to fetch.'],
      [
        'script that cannot run',
        (t) => (t.injectionError = 'Frame was removed'),
        'Could not run in the Notion tab: Frame was removed.',
      ],
    ]
    for (const [what, setUp, told] of cases) {
      const tab = new FakeNotionTab(PAGE_URL)
      setUp(tab)
      tab.install()
      const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
      expect([what, err.code, err.stopsQuestion]).toEqual([what, 'notion_error', `${UNEXPECTED_STOP} ${told}`])
      expect(tab.sent.length, what).toBeLessThanOrEqual(1)
    }
  })

  it('goes on after failures with a known meaning: the model is told', async () => {
    const cases: [number, string][] = [
      [401, 'signed_out'],
      [403, 'no_access'],
    ]
    for (const [status, code] of cases) {
      new FakeNotionTab(PAGE_URL).respond('loadPageChunk', status, { name: 'X', message: 'x' }).install()
      const err = await notionError((await activeNotionTab()).client.loadPage(PAGE))
      expect([err.code, err.stopsQuestion]).toEqual([code, undefined])
    }
  })

  it('[UC-NOTION-002-S18] stops the question when a change gets no answer, saying it may have been saved', async () => {
    for (const setUp of [
      (t: FakeNotionTab) => t.respondText('saveTransactionsFanout', 504, 'Gateway timeout'),
      (t: FakeNotionTab) => (t.networkDown = true),
    ]) {
      const tab = new FakeNotionTab(PAGE_URL)
      setUp(tab)
      tab.install()
      const err = await notionError((await activeNotionTab()).client.submitTransaction(SPACE, [rename], 'rename page'))
      expect([err.code, err.stopsQuestion, err.mayHaveChanged]).toEqual(['outcome_unknown', UNKNOWN_STOP, true])
      expect(tab.sent.length).toBeLessThanOrEqual(1)
    }
  })
})
