// Reading pages: read_page, and get_selection for what the user selected.
import { defineTool } from '../tool'
import { z } from '../zod'
import type { LoadedPage } from '../notion/api'
import { pageLink, toUuid } from '../notion/hosts'
import { mergeReads, pageRead } from '../notion/edit'
import { clip, threadCount } from '../notion/comments'
import { PAGE_TYPES, hexId, pageToMarkdown, splitSections } from '../notion/markdown'
import { activeNotionTab, selectionIn } from '../notion/tab'
import { needsAttachedPage } from './current'
import { loadForPart, loadMentioned } from './load'
import { generation, keepPartsRead, lastRead, partsReadOf, remember } from './memory'
import { NONE, PART_CHARS, READ, filled, idIn, named, on, pageArg, partArg, plainTitle, plural } from './shared'

export const readPage = defineTool({
  name: 'read_page',
  description:
    'Reads a Notion page as Markdown: the page open in the current tab, or another page by URL or id. ' +
    'Each block ends with a reference such as ^1a2b3c4d. Child pages, databases, and links to pages end with ' +
    'the page id, which this tool accepts. A long page comes in parts; ask for the next one with `part`.',
  touched: (_args, result) => ({ read: idIn(result, /^Page: .* \^([0-9a-f]{32})(?:\n|$)/) }),
  describe: (args, result) =>
    on(
      READ,
      // A database's name is plain text already; the header (up to the first blank line) says which it is.
      result?.split('\n\n')[0].includes('\nThis page is a database:')
        ? named(result, /^Page: (.+) \^[0-9a-f]+(?:\n|$)/)
        : plainTitle(named(result, /^Page: (.+) \^[0-9a-f]+(?:\n|$)/) ?? '') || undefined,
      // Arguments that don't parse may have named another page.
      !args || args.page ? 'a page' : 'the open page',
      args?.part && args.part > 1 ? `part ${args.part} of` : undefined,
    ),
  args: z.strictObject({
    page: z.string().describe('URL or id of the page to read. Leave out to read the open page.').optional(),
    part: partArg('Which part of a long page to read, starting at 1.'),
  }),
  run: async ({ page, part = 1 }) => {
    const since = generation()
    const pageText = filled(page)
    if (pageText === undefined) await needsAttachedPage()
    const tab = await activeNotionTab()
    const id = pageText === undefined ? tab.pageId : pageArg(pageText)
    if (!id) {
      throw new Error(
        pageText === undefined
          ? 'The Notion tab does not show a page. Open a page, or give its URL or id.'
          : `Not a Notion page URL or id: ${pageText}`,
      )
    }

    const { loaded, databaseMissing, reloaded } = await loadForPart(tab, id, part)
    if (!PAGE_TYPES.has(loaded.page.type)) {
      throw new Error('That id is a block inside a page, not a page. Read the page it is on instead.')
    }
    if (!mentionsLoaded.has(loaded)) {
      await loadMentioned(tab, loaded)
      mentionsLoaded.add(loaded)
    }
    const md = pageToMarkdown(loaded)
    // A row's properties come first, as front matter, and count toward the size of the first part.
    const front = md.properties.length ? [['---', ...md.properties, '---'].join('\n')] : []
    const owners = [...front.map(() => []), ...md.owners]
    const { parts, members } = splitSections([...front, ...md.sections], PART_CHARS)
    if (part > parts.length) {
      throw new Error(`This page has ${parts.length} part${parts.length === 1 ? '' : 's'}; there is no part ${part}.`)
    }

    const pageHex = hexId(loaded.page.id)
    const threads = threadCount(loaded, md)
    const header = [
      `Page: ${md.titleMarkdown} ^${pageHex}`,
      `URL: ${pageLink(tab.url, pageHex)}`,
      ...(parts.length > 1
        ? [`Part ${part} of ${parts.length}${part < parts.length ? `. Read part ${part + 1} for more.` : '.'}`]
        : []),
      ...(md.kind === 'database' ? ['This page is a database: read its rows with query_database.'] : []),
      ...(part === 1 && threads
        ? [
            `This page has ${plural(threads, 'comment thread')}: read ${threads === 1 ? 'it' : 'them'} with read_comments.`,
          ]
        : []),
      ...(loaded.complete ? [] : ['The page is too long to load in full; only its beginning is shown.']),
      ...(reloaded
        ? ['This part comes from a new read of the page; parts you have from an earlier read may not match it.']
        : []),
      ...(databaseMissing
        ? ["This is a database row, but its database can't be opened, so its properties are not shown."]
        : []),
    ]
    const body = parts[part - 1]
    const empty = md.kind === 'page' && !md.sections.length ? ['(This page is empty.)'] : []
    // What edit_page checks edits against: only the blocks this read showed, as they were. Part 1
    // starts a new read; later parts add to it.
    // The blocks this part drew, as the renderer reports them: never inferred from page text.
    const drawnIn = members.map((m) => new Set(m.flatMap(({ section, from, to }) => owners[section].slice(from, to))))
    const drawn = drawnIn[part - 1]
    // A block drawn in several parts (a paragraph longer than a part, say) is seen in full only
    // once each of them was read since part 1 (or since the page was loaded again).
    const read = part === 1 || reloaded ? new Set<number>() : (partsReadOf(loaded.page.id) ?? new Set<number>())
    read.add(part)
    const whole = (b: string) => drawnIn.every((d, n) => !d.has(b) || read.has(n + 1))
    const seen = pageRead(loaded, md, (b) => drawn.has(b), whole)
    keepPartsRead(loaded.page.id, read, since)
    remember(part === 1 ? seen : mergeReads(lastRead(loaded.page.id), seen), since)
    return [...header, '', ...(body ? [body] : []), ...(part === 1 ? empty : [])].join('\n')
  },
})

/** Loads whose mentioned people and pages were looked up, so later parts don't look again. */
const mentionsLoaded = new WeakSet<LoadedPage>()

export const getSelection = defineTool({
  name: 'get_selection',
  description:
    'Returns what the user has selected in the open Notion page: the selected text, and each selected block as ' +
    'Markdown with its reference, ready for edit_page (no read_page needed for those blocks). Use it when the user ' +
    'refers to what they selected: "the selection", "the highlighted text", or "this" on its own (as in "rewrite ' +
    'this"), not "this page". Nothing selected is a normal answer.',
  touched: () => NONE,
  describe: () => ({ verb: READ, what: 'the selection' }),
  args: z.strictObject({}),
  run: async () => {
    await needsAttachedPage()
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('The Notion tab does not show a page.')
    const selection = await selectionIn(tab.tabId)
    if (!selection?.blockIds.length) return 'Nothing is selected in the Notion page.'
    const loaded = await tab.client.loadPage(tab.pageId)
    const md = pageToMarkdown(loaded)
    // Blocks drawn without a line of their own (table rows, columns) stand for the nearest block
    // that has one, so only blocks whose content is shown count as read.
    const shown = (raw: string): string | undefined => {
      for (let b = toUuid(raw); b && md.refs.has(b); b = loaded.recordMap.block?.[b]?.parent_id)
        if (md.lines.has(b)) return b
      return undefined
    }
    const ids = [...new Set(selection.blockIds.map(shown).filter((b): b is string => !!b))]
    const missed = selection.blockIds.some((b) => !shown(b))
    const beyond = loaded.complete
      ? "aren't on the open page"
      : "aren't on the open page, or are past the part of it that could be loaded"
    if (!ids.length) return `The selected blocks ${beyond}. Read the page instead, or ask the user to select again.`
    // Blocks selected as blocks that reach the first or last block Notion drew may go on past it,
    // when the page has blocks there that weren't drawn.
    const order = [...md.refs.keys()]
    const selectedIds = new Set(selection.blockIds.map(toUuid))
    const picked = order.filter((b) => selectedIds.has(b))
    const pickedSet = new Set(picked)
    // The page's blocks that hold `b`, nearest first.
    const holders = (b: string): string[] => {
      const out: string[] = []
      for (
        let p = loaded.recordMap.block?.[b]?.parent_id;
        p && md.refs.has(p);
        p = loaded.recordMap.block?.[p]?.parent_id
      )
        out.push(p)
      return out
    }
    const first = picked[0]
    const last = picked.at(-1)
    const aboveFirst = new Set(first ? holders(first) : [])
    const goesOn =
      (selection.reaches?.start && first && order.slice(0, order.indexOf(first)).some((b) => !aboveFirst.has(b))) ||
      (selection.reaches?.end &&
        last &&
        (!loaded.complete ||
          order.slice(order.indexOf(last) + 1).some((b) => !holders(b).some((p) => pickedSet.has(p)))))
    // A block of several lines (a table, code) gets its reference on a line of its own.
    const lineOf = (b: string) => {
      const own = md.lines.get(b)!
      return `${own}${own.includes('\n') ? '\n' : ' '}^${md.refs.get(b)}`
    }
    // At most a part's worth, like read_page; at least one block.
    const lines: string[] = []
    let size = 0
    for (const b of ids) {
      const line = lineOf(b)
      if (lines.length && size + line.length > PART_CHARS) break
      lines.push(line)
      size += line.length + 1
    }
    const more = ids.length - lines.length
    // The blocks shown count as read, so edit_page can change them by these references.
    const chosen = new Set(ids.slice(0, lines.length))
    remember(
      mergeReads(
        lastRead(loaded.page.id),
        pageRead(loaded, md, (b) => chosen.has(b)),
      ),
    )
    const pageHex = hexId(loaded.page.id)
    return [
      `Selection on the page “${md.title}” ^${pageHex}:`,
      '',
      ...(selection.text === undefined ? [] : [`Selected text: “${clip(selection.text, 2000)}”`, '']),
      `Selected block${ids.length === 1 ? '' : 's'}:`,
      ...lines,
      ...(more ? ['', `${more} more selected block${more === 1 ? '' : 's'}: read the page for them.`] : []),
      ...(missed ? ['', `Only part of the selection is shown: the other selected blocks ${beyond}.`] : []),
      ...(goesOn
        ? [
            '',
            'The selection may go on past the part of the page Notion has drawn in the browser, so some selected ' +
              'blocks may be missing. Ask the user whether more is selected, or read the page.',
          ]
        : []),
    ].join('\n')
  },
})
