// Writing pages: edit_page changes a page's content, create_page makes a page or a row, and
// update_pages changes titles, icons, and properties.
import { defineTool } from '../tool'
import { z } from '../zod'
import { NotionError, blockOps, type Operation, type RecordMap } from '../notion/api'
import { pageLink } from '../notion/hosts'
import {
  EDIT_ARGS,
  EditError,
  forget,
  mergeReads,
  parseEdits,
  holdsUnshown,
  keepDates,
  keepUnshown,
  pageRead,
  planEdit,
  previewEdits,
  planNewPage,
} from '../notion/edit'
import {
  MarkdownError,
  blockTitles,
  blocksWithPeople,
  parseMarkdown,
  personNames,
  withPeople,
  type NewBlock,
  type RichText,
} from '../notion/blocks'
import { findPeople, peopleIn } from '../notion/people'
import { clip, quote } from '../notion/comments'
import {
  PropertyError,
  losesUnnamedPeople,
  oneLine,
  propertyValue,
  richValue,
  sameMarkdown,
  schemaEntry,
  shownInput,
  shownMarkdown,
  storedText,
  type PropertyDef,
  type PropertyInput,
} from '../notion/props'
import { PAGE_TYPES, hexId, pageToMarkdown, type Schema } from '../notion/markdown'
import { activeNotionTab } from '../notion/tab'
import { loadMentioned, resolveDatabase } from './load'
import {
  forgetLoads,
  forgetRead,
  forgetSeenRow,
  generation,
  lastRead,
  remember,
  renameRead,
  seenDatabase,
  seenRow,
  type SeenRow,
} from './memory'
import {
  CREATE,
  EDIT,
  GIVE_PAGE,
  NONE,
  PAGES_LIST,
  QUOTED,
  TITLE_EMPTY,
  UPDATE,
  count,
  filled,
  idIn,
  idsOf,
  on,
  pageArg,
  plainTitle,
  quoted,
  shownText,
} from './shared'

const EDITS_LIST = '`edits` must be a list with at least one edit.'

/** The first line of an edit_page result, which names the page. */
const EDITED_PAGE = new RegExp(`^On the page (${QUOTED}) \\^[0-9a-f]+:$`, 'm')

export const editPage = defineTool({
  changesData: true,
  name: 'edit_page',
  description:
    'Changes a Notion page you have read with read_page: insert Markdown after a block, inside one, or at the start ' +
    'or end of the page, replace a block with Markdown, or delete a block. Blocks are named by the references ' +
    'read_page shows. All edits in one call are applied together, or none are. Supported Markdown: paragraphs, ' +
    '# headings, - lists, 1. lists, - [ ] to-dos, ▸ toggles, > quotes, > [!💡] callouts, ``` code, ---, ' +
    '$$equations$$, | tables |, **bold**, *italic*, ~~strike~~, `code`, $inline equations$, ' +
    '<span color="red">colors</span>, [links](url), [page](<page id>) mentions, @2026-01-31 dates, and @[Name] ' +
    'mentions of workspace members by name; a backslash keeps a character literal (\\$5). ' +
    'Indent by two spaces to nest under lists, to-dos, toggles, paragraphs, and headings (which makes a toggle ' +
    'heading); inside a quote or callout, nest with "> " and two spaces. ' +
    "Child pages, databases, and files can't be written. If the page changed since you read it, the edit is " +
    'refused: read it again and redo the edit.',
  // Edits that all matched what the page had wrote nothing, and changed nothing.
  touched: (args, result) =>
    result
      .split('\n')
      .slice(1)
      .every((line) => line.endsWith('already had that content; nothing changed.'))
      ? NONE
      : { changed: idsOf(args && [args.page]) },
  describe: (_args, result) => on(EDIT, quoted(result, EDITED_PAGE), 'a page'),
  args: z.strictObject({
    page: z.string({ error: GIVE_PAGE }).describe('Id of the page to edit, as read_page shows it after "Page:".'),
    edits: z.array(EDIT_ARGS, { error: EDITS_LIST }).min(1, { error: EDITS_LIST }),
  }),
  preview: (args) => {
    const given = filled(args.page)
    if (!given) return undefined
    return previewEdits(args.edits, lastRead(pageArg(given) ?? ''), given)
  },
  run: async (args, signal) => {
    const since = generation()
    // The page is named in the call, so the page the preview names is the page that gets changed.
    const given = filled(args.page)
    if (!given) throw new EditError(GIVE_PAGE)
    const id = pageArg(given)
    if (!id) throw new Error(`Not a Notion page URL or id: ${given}`)
    const tab = await activeNotionTab()
    const read = lastRead(id)
    if (!read) throw new EditError('Read the page with read_page first, then edit it using the references it shows.')
    const edits = parseEdits(args.edits, read)

    const loaded = await tab.client.loadPage(id)
    if (loaded.page.type !== 'page') {
      throw new EditError(
        PAGE_TYPES.has(loaded.page.type)
          ? "That is a database; edit_page can't change it."
          : 'That id is a block inside a page, not a page.',
      )
    }
    // The edit is checked against the page first, so a refused edit costs no member lookup.
    planEdit(loaded, read, edits)
    const writes = edits.filter((e) => e.action !== 'delete')
    // Names read_page showed for people the page mentions, so a name a rewritten block already
    // mentions is matched to that person. Only needed when the new Markdown mentions someone.
    if (writes.some((e) => personNames(blockTitles(e.blocks)).length)) await loadMentioned(tab, loaded)
    // People the new Markdown mentions, matched before anything is written. In a block being
    // rewritten, a name it already mentions is that same person.
    const users = loaded.recordMap.notion_user
    const blocks = loaded.recordMap.block ?? {}
    // The text a block being rewritten holds: a table's is in its rows' cells.
    const textOf = (id: string): unknown[] => {
      const block = blocks[id]
      const title = block?.properties?.title
      if (block?.type !== 'table') return Array.isArray(title) ? title : []
      return (block.content ?? []).flatMap((row) =>
        Object.values(blocks[row]?.properties ?? {}).flatMap((v) => (Array.isArray(v) ? v : [])),
      )
    }
    const found = await findPeople(
      tab.client,
      loaded.spaceId,
      writes.map((e) => ({
        names: personNames(blockTitles(e.blocks)),
        known: e.action === 'replace' ? peopleIn(textOf(e.target), users) : undefined,
      })),
    )
    writes.forEach((e, n) => {
      e.people = found[n]
      e.blocks = blocksWithPeople(e.blocks, found[n])
    })
    const plan = planEdit(loaded, read, edits)
    // The first line names the page, for the agent and for the side panel.
    const header = `On the page ${quote(read.title)} ^${hexId(id)}:`
    // The last point where nothing has been sent: a Stop pressed while the page loaded wins.
    // Every edit was a no-op: there is nothing to send, and the page stays as read.
    if (!plan.operations.length) return [header, ...plan.summary].join('\n')
    signal?.throwIfAborted()
    try {
      await tab.client.submitTransaction(loaded.spaceId, plan.operations, 'Notico: edit_page')
    } catch (err) {
      // The edit may have been saved: a retry from the same read could apply it twice, so the
      // page must be read again first, which also shows whether it landed.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        forgetRead(id)
        forgetLoads(id)
      }
      throw err
    }

    // The page changed: forget cached parts. What the agent saw stays as it was, except for what
    // this edit changed, so a block the user changed meanwhile is still refused.
    forgetLoads(id)
    // Blocks it changed or deleted need a new read before they are edited again.
    let next = forget(read, [...plan.deleted, ...plan.changed.filter((b) => b !== id)])
    let newRefs = ''
    try {
      const after = await tab.client.loadPage(id)
      // Only the blocks this edit created: anyone may have changed the others since it was saved,
      // so blocks it changed are left for the next read_page to show.
      const ours = new Set(plan.createdAll)
      next = mergeReads(
        next,
        pageRead(after, pageToMarkdown(after), (b) => ours.has(b)),
      )
      const refs = plan.created.map((c) => next.refs.get(c)).filter(Boolean)
      if (refs.length) newRefs = `New blocks: ${refs.map((r) => `^${r}`).join(', ')}.`
    } catch (err) {
      // The edit is saved; blocks it changed will be refused until the page is read again. A
      // failure that stops the question is passed on, marked as having changed the page.
      if (err instanceof NotionError && err.stopsQuestion) {
        remember(next, since)
        throw new NotionError(
          'notion_error',
          [
            'The edit was saved. Reading the page back afterwards was refused, so read it again before changing it.',
            ...plan.summary,
          ].join('\n'),
          { cause: err, stopsQuestion: `The edit was saved. ${err.stopsQuestion}`, mayHaveChanged: true },
        )
      }
    }
    remember(next, since)
    return [header, ...plan.summary, newRefs, 'Read the page again to see the result.'].filter(Boolean).join('\n')
  },
})

/** Page titles and text properties are inline Markdown (see richValue). */
const INLINE_MARKDOWN =
  'inline Markdown as query_database and read_page show text (bold, links, `[Title](page id)`, `@[Name]`, ' +
  '`@2026-11-20`): put a backslash before a character that must stay literal, and write a backslash itself as \\\\'

/** A page's new title, from the Markdown the model gives: on one line, as rich text and as previews show it. */
function pageTitle(value: string): { rich: RichText; shown: string } {
  const markdown = oneLine(value)
  try {
    return { rich: richValue(markdown), shown: shownMarkdown(markdown) }
  } catch (err) {
    if (err instanceof PropertyError) throw new EditError(err.message)
    throw err
  }
}

/** `properties` as tools take it: values by property name. */
const PROPERTIES_ARG = z
  .record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()], {
      error: (issue) =>
        `The value for “${oneLine(String(issue.path?.at(-1)))}” must be text, a number, Yes/No, or a list.`,
    }),
    { error: '`properties` must be an object of values by name.' },
  )
  .describe(
    'Database properties by name: text, a number, Yes/No for checkboxes, an option name (a list for ' +
      'multi-select), or a date as YYYY-MM-DD (a range as "YYYY-MM-DD → YYYY-MM-DD"). Empty clears a value. ' +
      'The title goes in `title`, not here. Setting a date replaces any time or reminder it had. ' +
      `A text property is ${INLINE_MARKDOWN}; a line break in it is \`<br>\`. In other values, Markdown ` +
      'escapes are undone.',
  )
  .optional()

const CREATE_PARENT = '`parent` is required: the URL or id of the page or database to create it in.'

export const createPage = defineTool({
  changesData: true,
  name: 'create_page',
  description:
    'Creates a Notion page with a title and Markdown content (the same Markdown as edit_page). `parent` is a page ' +
    "(the open page's URL, or another page), and the new page goes at its end; or a " +
    'database, and the new page is a row of it, with `properties` set by name (values as query_database shows ' +
    "them; options must exist). Returns the new page's id and URL.",
  touched: (_args, result) => ({ changed: idIn(result, /^(?:Added the row|Created the page) “.*” \^([0-9a-f]{32}) /) }),
  describe: (args) => {
    const name = plainTitle(args?.title ?? '').trim()
    return name ? { verb: CREATE, what: 'the page', name } : { verb: CREATE, what: 'a page' }
  },
  args: z.strictObject({
    title: z.string({ error: TITLE_EMPTY }).describe(`The new page's title, on one line: ${INLINE_MARKDOWN}.`),
    markdown: z.string().describe("The page's content, as Markdown. Leave out for an empty page.").optional(),
    parent: z.string({ error: CREATE_PARENT }).describe('URL or id of the page or database to create it in.'),
    properties: PROPERTIES_ARG,
  }),
  preview: (args) => {
    const title = shownMarkdown(args.title)
    // The page exactly as `run` will resolve it, so the user sees where the page went.
    const given = args.parent.trim()
    const id = given ? pageArg(given) : undefined
    // By name when the agent has read it, so the user can tell which page or database it is.
    const database = id ? seenDatabase(id) : undefined
    const known = id ? (database ?? lastRead(id)?.title) : undefined
    const parent = id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : given || '(none given)'
    const markdown = filled(args.markdown) ?? '(empty)'
    const props = Object.entries(args.properties ?? {})
    // Each part on a line of its own, so text in the title can't read as where the page goes.
    // Whether the parent is a page or a database decides what happens; say it only when known.
    const row = !!database || props.length > 0
    const page = !row && !!id && !!lastRead(id)
    return [
      row ? 'Add a row to a database' : 'Create a page',
      `Title: ${title}`,
      row
        ? `In: ${parent}`
        : page
          ? `At the end of: ${parent}`
          : `In: ${parent} (at its end if it is a page; as a new row if it is a database)`,
      ...(props.length ? ['Properties:', ...props.map(([name, v]) => `    ${oneLine(name)}: ${shownInput(v)}`)] : []),
      'Content:',
      ...markdown.split('\n').map((l) => `    ${l}`),
    ].join('\n')
  },
  run: async (args, signal) => {
    const { rich, shown: title } = pageTitle(args.title)
    if (!rich.length) throw new Error(TITLE_EMPTY)
    const given = args.parent.trim()
    if (!given) throw new Error(CREATE_PARENT)
    const parentId = pageArg(given)
    if (!parentId) throw new Error(`Not a Notion page URL or id: ${given}`)
    const props = Object.entries(args.properties ?? {})
    const tab = await activeNotionTab()
    let blocks: NewBlock[] = []
    const markdown = filled(args.markdown)
    if (markdown) {
      try {
        blocks = parseMarkdown(markdown)
      } catch (err) {
        if (err instanceof MarkdownError) throw new EditError(err.message)
        throw err
      }
    }
    const parent = (await tab.client.getRecords([{ table: 'block', id: parentId }])).block![parentId]
    let target: { id: string; table: 'block' | 'collection' }
    let spaceId: unknown = parent.space_id
    let properties: Record<string, RichText> = {}
    if (parent.type === 'collection_view_page' || parent.type === 'collection_view') {
      // A row goes in the database's data source, in the workspace that holds it.
      const db = await resolveDatabase(tab.client, parent)
      target = { id: db.collectionId, table: 'collection' }
      spaceId = db.spaceId
      properties = toProperties(db.schema, props)
    } else if (parent.type === 'page') {
      if (props.length) throw new EditError('`properties` are only for rows: that parent is a page, not a database.')
      target = { id: parentId, table: 'block' }
    } else {
      throw new EditError('That id is a block inside a page, not a page or a database.')
    }
    if (typeof spaceId !== 'string' || !spaceId)
      throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
    // People the title, the properties, and the content mention, matched before anything is written.
    const written = [...blockTitles(blocks), rich, ...Object.values(properties)]
    const [people] = await findPeople(tab.client, spaceId, [{ names: personNames(written) }])
    blocks = blocksWithPeople(blocks, people)
    properties = Object.fromEntries(Object.entries(properties).map(([key, v]) => [key, withPeople(v, people)]))
    const { operations, pageId } = planNewPage(target, spaceId, withPeople(rich, people), blocks, tab.client.userId, {
      properties,
    })
    signal?.throwIfAborted()
    // The parent's list changes: cached parts of it would hide the new page, and after an unknown
    // outcome the agent must see whether it was created before it tries again.
    try {
      await tab.client.submitTransaction(spaceId, operations, 'Notico: create_page')
    } catch (err) {
      // A retry would create a second page if this one was saved: the agent must look first.
      if (err instanceof NotionError && err.code === 'outcome_unknown') {
        forgetRead(parentId)
        throw new NotionError(
          'outcome_unknown',
          `Notion did not confirm it, so the page may or may not have been created. ` +
            `${target.table === 'collection' ? 'Query' : 'Read'} ^${hexId(parentId)} and check for “${title}” ` +
            'before trying again.',
          { cause: err, stopsQuestion: err.stopsQuestion },
        )
      }
      throw err
    } finally {
      forgetLoads(parentId)
    }
    const hex = hexId(pageId)
    return [
      target.table === 'collection'
        ? `Added the row “${title}” ^${hex} to the database ^${hexId(parentId)}.`
        : `Created the page “${title}” ^${hex} at the end of ^${hexId(parentId)}.`,
      `URL: ${pageLink(tab.url, hex)}`,
    ].join('\n')
  },
})

/** How many pages one update_pages call changes at most, so its preview stays readable. */
export const UPDATE_MAX = 50

/** Which entry of `pages` an issue is about, as the model is told: "Page 1". */
const pageAt = (issue: { path?: PropertyKey[] }) => `Page ${Number(issue.path?.[1]) + 1}`
const needsPage = (issue: { path?: PropertyKey[] }) =>
  `${pageAt(issue)} needs \`page\`: the id or URL of a page or row.`

const UPDATE_ARGS = z.strictObject({
  pages: z
    .array(
      z.strictObject(
        {
          page: z.string({ error: needsPage }).describe('Id or URL of the page or row.'),
          title: z
            .string({ error: (issue) => `${pageAt(issue)}: ${TITLE_EMPTY}` })
            .describe(`A new title, on one line: ${INLINE_MARKDOWN}.`)
            .optional(),
          icon: z
            .string({ error: (issue) => `${pageAt(issue)}: \`icon\` must be an emoji.` })
            .describe('A new icon: one emoji.')
            .optional(),
          properties: PROPERTIES_ARG,
        },
        // An entry that is not an object names no page; an unknown key keeps zod's own words.
        { error: (issue) => (issue.code === 'invalid_type' ? needsPage(issue) : undefined) },
      ),
      { error: PAGES_LIST },
    )
    .min(1, { error: PAGES_LIST })
    .max(UPDATE_MAX, { error: `At most ${UPDATE_MAX} pages can change in one call.` }),
})

export const updatePages = defineTool({
  changesData: true,
  name: 'update_pages',
  description:
    "Changes pages' titles, icons (an emoji), or database properties (for rows, by name, values as " +
    'query_database shows them; options must exist; empty clears a value), several pages in one call: "mark ' +
    'these five tasks done" is one call. Get row ids from query_database. Nothing is written if any value is ' +
    'refused.',
  touched: (args) => ({ changed: idsOf(args?.pages.map((p) => p.page)) }),
  describe: (args) => ({ verb: UPDATE, what: args ? count(args.pages.length, 'page') : 'pages' }),
  args: UPDATE_ARGS,
  preview: ({ pages: updates }) => {
    const lines = [`Change ${updates.length} page${updates.length === 1 ? '' : 's'}`]
    for (const u of updates) {
      const given = u.page.trim()
      const id = given ? pageArg(given) : undefined
      const seen = id ? seenRow(id) : undefined
      const known = seen ? shownText(seen.title) : id ? lastRead(id)?.title : undefined
      lines.push(id ? `${known ? `${oneLine(known)} ` : ''}^${hexId(id)}` : oneLine(given) || '(no page given)')
      if (u.title !== undefined) {
        const title = shownMarkdown(u.title)
        const old = seen
          ? change(shownMarkdown(seen.title, { cell: false }), title, sameMarkdown(seen.title, oneLine(u.title)))
          : ''
        lines.push(`    Title: ${title}${old}`)
      }
      if (u.icon !== undefined) lines.push(`    Icon: ${oneLine(u.icon)}`)
      for (const [name, v] of Object.entries(u.properties ?? {}))
        lines.push(`    ${oneLine(name)}: ${previewValue(seen, name, v)}`)
    }
    return lines.join('\n')
  },
  run: async (args, signal) => {
    const updates = parseUpdates(args.pages)
    const tab = await activeNotionTab()
    const ids = updates.map((u) => u.id)
    const blocks = (await tab.client.getRecords(ids.map((id) => ({ table: 'block', id })))).block!
    for (const u of updates) {
      const block = blocks[u.id]
      if (PAGE_TYPES.has(String(block.type)) && block.type !== 'page')
        throw new EditError(`^${hexId(u.id)} is a database; its name can't be changed with update_pages.`)
      if (block.type !== 'page') throw new EditError(`^${hexId(u.id)} is a block inside a page, not a page.`)
      if (u.props.length && block.parent_table !== 'collection')
        throw new EditError(
          `^${hexId(u.id)} isn't a database row, so it has no properties; only its title and icon can change.`,
        )
    }
    const spaces = new Set(updates.map((u) => String(blocks[u.id].space_id)))
    if (spaces.size > 1)
      throw new EditError('These pages are in different workspaces: change each workspace’s pages in its own call.')
    const spaceId = [...spaces][0]
    // Each row's database, for its schema.
    const collectionIds = [...new Set(updates.filter((u) => u.props.length).map((u) => String(blocks[u.id].parent_id)))]
    const collections = collectionIds.length
      ? (await tab.client.getRecords(collectionIds.map((id) => ({ table: 'collection', id, spaceId })))).collection!
      : {}
    const changes = updates.map((u) => {
      const block = blocks[u.id]
      const schema = (collections[String(block.parent_id)]?.schema ?? {}) as Schema
      const values = u.props.length ? toProperties(schema, u.props) : {}
      if (u.title !== undefined) values.title = u.title.rich
      // The text and title being set: what the page stores for them now is looked at below.
      const texts = Object.keys(values).filter((key) => key === 'title' || schema[key]?.type === 'text')
      // A person shown as @someone can't be written back: the text would replace the mention.
      const unnamed = texts.find((key) => losesUnnamedPeople(values[key], block.properties?.[key]))
      if (unnamed)
        throw new EditError(
          `^${hexId(u.id)}: ${unnamed === 'title' ? 'the title' : (schema[unnamed]?.name ?? unnamed)} mentions a ` +
            'person whose name could not be read, shown as @someone. Writing @someone back would replace that ' +
            'mention with text: leave this value as it is, or name the person as @[Name]. Nothing was written.',
        )
      return { values, texts, names: personNames(Object.values(values)), block, schema }
    })
    // People the new values mention, matched before anything is written. A name the old value
    // already mentions is that same person, so a value written back as read keeps its mentions.
    // The same names tell what an old value shows of the people it mentions, where it holds something
    // its Markdown doesn't show.
    const mentioning = changes.filter(
      (c) => c.names.length || c.texts.some((key) => holdsUnshown(c.block.properties?.[key])),
    )
    const users = [
      ...new Set(mentioning.flatMap((c) => c.texts.flatMap((key) => mentioned(c.block.properties?.[key])))),
    ]
    let named: RecordMap = {}
    try {
      named = await tab.client.findRecords(users.map((id) => ({ table: 'notion_user' as const, id })))
    } catch (err) {
      // As in loadMentioned: only names, so a person out of reach is looked up among the members.
      if (!(err instanceof NotionError && (err.code === 'no_access' || err.code === 'in_trash'))) throw err
    }
    const found = await findPeople(
      tab.client,
      spaceId,
      changes.map((c) => ({
        names: c.names,
        known: peopleIn(
          c.texts.flatMap((key): unknown[] => {
            const runs = c.block.properties?.[key]
            return Array.isArray(runs) ? runs : []
          }),
          named.notion_user,
        ),
      })),
    )
    const op = blockOps(spaceId, Date.now(), tab.client.userId)
    const operations: Operation[] = []
    const summary: string[] = []
    updates.forEach((u, n) => {
      const { texts, block, schema } = changes[n]
      const values = Object.fromEntries(
        Object.entries(changes[n].values).map(([key, value]) => {
          const rich = withPeople(value, found[n])
          if (!texts.includes(key)) return [key, rich]
          const old = block.properties?.[key]
          // A date mention keeps what the old text stored with it, which query_database doesn't show.
          // So does the rest of the text, where the new value still has it as it was shown.
          const kept = keepUnshown(keepDates(rich, [old]), old, named.notion_user)
          if (kept.lost.length)
            throw new EditError(
              `^${hexId(u.id)}: ${key === 'title' ? 'the title' : (schema[key]?.name ?? key)} holds ` +
                `${kept.lost.map((l) => `${l.what.join(' and ')} on “${clip(oneLine(l.on), 60)}”`).join('; ')}. ` +
                'Reading the value doesn’t show that, and this change would remove it. Write that text exactly as ' +
                'it was shown to keep it, or leave the value as it is and tell the user to change it in Notion. ' +
                'Nothing was written.',
            )
          return [key, kept.rich]
        }),
      )
      if (Object.keys(values).length) operations.push(op.setProperties(u.id, values))
      if (u.icon !== undefined) operations.push(op.setFormat(u.id, { page_icon: u.icon }))
      operations.push(op.touch(u.id))
      const changed = [
        ...(u.title !== undefined ? ['title'] : []),
        ...(u.icon !== undefined ? ['icon'] : []),
        ...u.props.map(([n]) => oneLine(n)),
      ]
      summary.push(`^${hexId(u.id)}: ${changed.join(', ')}`)
    })
    signal?.throwIfAborted()
    try {
      // Setting values again does no harm, so after a lost answer the agent may simply retry.
      await tab.client.submitTransaction(spaceId, operations, 'Notico: update_pages')
    } catch (err) {
      // Whether a rename landed is unknown: the page's read, and the title it shows, go too.
      if (err instanceof NotionError && err.code === 'outcome_unknown') for (const id of ids) forgetRead(id)
      throw err
    } finally {
      for (const id of ids) {
        forgetSeenRow(id)
        forgetLoads(id)
      }
    }
    // A read's title shows in later previews; keep it current.
    for (const u of updates) if (u.title !== undefined) renameRead(u.id, u.title.shown)
    return [`Changed ${updates.length} page${updates.length === 1 ? '' : 's'}:`, ...summary].join('\n')
  },
})

/**
 * How a value differs from the old one the agent saw, for the preview. Text that reads the same may
 * still differ in what is stored (`same`): its formatting, links, or mentions.
 */
function change(old: string, now: string, same = old === now): string {
  if (same) return ' (unchanged)'
  return old === now ? ' (same text; its formatting changes)' : ` (was ${old || 'empty'})`
}

/** The ids of the people rich text mentions. */
function mentioned(value: unknown): string[] {
  const runs = (Array.isArray(value) ? value : []) as [string, [string, unknown?][]?][]
  return runs.flatMap((run) =>
    (Array.isArray(run?.[1]) ? run[1] : []).flatMap(([mark, id]) =>
      mark === 'u' && typeof id === 'string' ? [id] : [],
    ),
  )
}

/**
 * A property's new value for update_pages' preview: as it will be stored when the agent saw the
 * row's database, with the old value it saw; as given otherwise, or when it will be refused.
 */
function previewValue(seen: SeenRow | undefined, name: string, input: PropertyInput): string {
  if (!seen) return shownInput(input)
  let def: PropertyDef
  let now: string
  let markdown: string | undefined
  try {
    let key: string
    ;[key, def] = schemaEntry(seen.schema, name)
    // `run` refuses the title among the properties.
    if (key === 'title' || def.type === 'title') return shownInput(input)
    const value = propertyValue(def, input)
    // Text is Markdown: shown as the user reads it, and compared as it is stored.
    markdown = def.type === 'text' && typeof input === 'string' && value.length ? input.trim() : undefined
    now = markdown === undefined ? storedText(def, value) : shownMarkdown(markdown, { lines: true })
  } catch (err) {
    if (err instanceof PropertyError) return shownInput(input)
    throw err
  }
  const property = (def.name ?? name).trim().toLowerCase()
  const old = seen.values.find((v) => v.name.toLowerCase() === property)?.value
  if (old === undefined) return now || '(empty)'
  if (markdown !== undefined)
    return now + change(shownMarkdown(old, { cell: false }), now, sameMarkdown(old, markdown, { lines: true }))
  // As storedText shows it: plain text, without query_database's Markdown marks, links, or the @
  // before a date; options without spaces.
  let was = oneLine(shownText(old))
  if (def.type === 'multi_select') was = was.split(/\s*,\s*/).join(', ')
  // The write replaces the whole date, so a reminder query_database didn't show goes.
  if (def.type === 'date' && seen.reminders.has(property))
    return `${now || '(empty)'} (${was === now ? 'same date' : `was ${was || 'empty'}`}; its reminder is removed)`
  return (now || '(empty)') + change(was, now)
}

/** Whether `text` is exactly one emoji (flags and keycaps included), as Notion takes for an icon. */
function isEmoji(text: string): boolean {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(text)
}

/** update_pages' `pages`, checked before anything is asked of Notion. */
function parseUpdates(pages: z.output<typeof UPDATE_ARGS>['pages']) {
  const seen = new Set<string>()
  return pages.map((u, i) => {
    const id = pageArg(u.page)
    if (!id) throw new EditError(`Page ${i + 1} needs \`page\`: the id or URL of a page or row.`)
    if (seen.has(id)) throw new EditError(`^${hexId(id)} is given twice; put all its changes in one entry.`)
    seen.add(id)
    const title = u.title === undefined ? undefined : pageTitle(u.title)
    if (title && !title.rich.length) throw new EditError(`Page ${i + 1}: ${TITLE_EMPTY}`)
    const icon = u.icon?.trim()
    if (icon !== undefined && !isEmoji(icon)) throw new EditError(`Page ${i + 1}: \`icon\` must be an emoji.`)
    const props = Object.entries(u.properties ?? {})
    if (title === undefined && icon === undefined && !props.length)
      throw new EditError(`Page ${i + 1} changes nothing: give \`title\`, \`icon\`, or \`properties\`.`)
    return { id, title, icon, props }
  })
}

/** Property values as Notion stores them, by schema key; the title is given as `title` instead. */
function toProperties(schema: Schema, props: [string, PropertyInput][]): Record<string, RichText> {
  const out: Record<string, RichText> = {}
  for (const [name, input] of props) {
    const [key, def] = schemaEntry(schema, name)
    if (key === 'title' || def.type === 'title')
      throw new EditError(`Give the title as \`title\`, not as “${oneLine(name)}”.`)
    if (key in out) throw new EditError(`“${oneLine(name)}” is given twice.`)
    try {
      out[key] = propertyValue(def, input)
    } catch (err) {
      if (err instanceof PropertyError) throw new EditError(err.message)
      throw err
    }
  }
  return out
}
