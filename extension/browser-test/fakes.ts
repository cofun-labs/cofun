// What the browser tests answer in place of Notion's API and the worker's model, signed in. Written by
// hand and kept small: the browser tests check that the built extension's paths work in Chrome, and
// leave what Notion and the model answer in every other case to the extension's and the worker's tests.

const SPACE = '5a5a5a5a-0000-4000-8000-000000000001'
export const USER = '0e0e0e0e-0000-4000-8000-000000000002'
/** A page at the top of the workspace, holding the page the tab shows. */
const PARENT = '1a1a1a1a-0000-4000-8000-000000000010'
/** The page the Notion tab shows, which the tool test reads and trashes. */
export const PAGE = '1a1a1a1a-0000-4000-8000-000000000020'
const TEXT = '1b1b1b1b-0000-4000-8000-000000000021'
export const PAGE_TITLE = 'Smoke test page'
export const PAGE_URL = `https://app.notion.com/p/Smoke-test-page-${PAGE.replaceAll('-', '')}`

type NotionRecord = Record<string, unknown> & { id: string }

const RECORDS: NotionRecord[] = [
  {
    id: PARENT,
    type: 'page',
    properties: { title: [['Smoke test parent']] },
    content: [PAGE],
    parent_id: SPACE,
    parent_table: 'space',
  },
  {
    id: PAGE,
    type: 'page',
    properties: { title: [[PAGE_TITLE]] },
    content: [TEXT],
    parent_id: PARENT,
    parent_table: 'block',
  },
  {
    id: TEXT,
    type: 'text',
    properties: { title: [['A line written for the smoke test.']] },
    parent_id: PAGE,
    parent_table: 'block',
  },
].map((record) => ({
  version: 1,
  alive: true,
  space_id: SPACE,
  created_time: 1767225600000,
  last_edited_time: 1767225600000,
  ...record,
}))

function wrap(record: NotionRecord) {
  return { spaceId: SPACE, value: { role: 'editor', value: record } }
}

function find(id: unknown): NotionRecord | undefined {
  return RECORDS.find((record) => record.id === id)
}

/** A Notion request the tab sent, as the fake took it. */
export interface NotionRequest {
  endpoint: string
  body: Record<string, unknown>
  /** The user the request named (Notion's x-notion-active-user-header). */
  user: string | undefined
}

/**
 * Notion's answer to a request to `/api/v3/<endpoint>`, in its response shapes, from the records
 * above. Undefined for a request the fake doesn't know, which the test then blocks.
 */
export function notionAnswer({ endpoint, body }: NotionRequest): unknown {
  if (endpoint === 'loadPageChunk') {
    const page = find((body.page as { id?: unknown } | undefined)?.id)
    const blocks = page ? [page, ...((page.content as string[] | undefined) ?? []).flatMap((id) => find(id) ?? [])] : []
    return {
      cursor: { stack: [] },
      recordMap: { __version__: 3, block: Object.fromEntries(blocks.map((b) => [b.id, wrap(b)])) },
    }
  }
  if (endpoint === 'syncRecordValuesMain') {
    // A body of another shape is left unanswered, so the test fails on a blocked request, not a hang.
    if (!Array.isArray(body.requests)) return undefined
    const block: Record<string, unknown> = {}
    for (const request of body.requests as unknown[]) {
      const pointer = (request as { pointer?: { id?: unknown; table?: unknown } } | null)?.pointer
      const record = pointer?.table === 'block' ? find(pointer.id) : undefined
      if (record) block[record.id] = wrap(record)
    }
    return { recordMap: { __version__: 3, block } }
  }
  if (endpoint === 'saveTransactionsFanout') return {}
  // Trashing a page also takes it out of Notion's search.
  if (endpoint === 'deleteContentRecords') return { recordMap: { __version__: 3 } }
  return undefined
}

/** What the hosted model says, as the worker streams it: OpenAI's chunks, the cost, then `[DONE]`. */
export function completionStream(reply: { text: string } | { call: string; args: unknown }): string {
  const delta =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${reply.call}`,
              type: 'function',
              function: { name: reply.call, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
  const chunks = [
    { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id: 'chatcmpl-smoke',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    { cost: { micro_credits: 1000, estimated: false } },
  ]
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
}
