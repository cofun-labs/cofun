// The tools that change Confluence. The model chooses what to write and where, as in Notico: each
// argument is parsed with its schema, and the page a call names is a reference a Confluence tool
// returned in this question or a link to a page on the captured site. Only moving a page to the trash
// asks the user first; Read only turns every write off before its preview.
import type { ToolContext } from '@cofun/agent'
import { prepareCloudPageEdit } from '../confluence/cloud-edits'
import { prepareCloudOrganization, prepareCloudTrash } from '../confluence/cloud-organization'
import { applyCloudLabel, prepareCloudComment, prepareCloudPageWrite } from '../confluence/cloud-writes'
import { applyComment, prepareComment } from '../confluence/comments'
import { applyLabel, labelName } from '../confluence/labels'
import { applyOrganization, prepareOrganization, type OrganizationRequest } from '../confluence/page-organization'
import { applyPageTrash, preparePageTrash } from '../confluence/page-status'
import {
  applyPageEdit,
  applyPageWrite,
  describePageWrite,
  linkedPage,
  preparePageEdit,
  preparePageWrite,
  title,
  type PageWriteRequest,
} from '../confluence/page-writes'
import { pageReference, type PageReference } from '../confluence/references'
import { captureConfluenceTab, refuse, type ConfluenceTab } from '../confluence/tab'
import { requirePage } from './confluence'
import { target } from './target'
import { defineTool } from '../tool'
import { z } from '../zod'
import type { ConfluenceQuestion, ToolMemory } from './memory'
import { asData } from '@cofun/tools'
import { on, verb } from './shared'

interface ChangeResult {
  data: object
  changed: boolean
}

interface Plan {
  preview: string
  confirm?: boolean
  apply(signal?: AbortSignal): Promise<ChangeResult>
}

/** A page a write names: a reference from a Confluence tool, or a link to a page on this site. */
const pageTarget = z.union([
  pageReference,
  z.string().min(1).max(2048).describe('A link to a published page on the Confluence site in the current tab.'),
])
type PageTarget = z.output<typeof pageTarget>
const page = pageTarget
  .optional()
  .describe(
    'The page: a page reference returned by a Confluence tool in this question, or a link to a page on this Confluence site. Omit for the page open in the current tab.',
  )

/** The page a call names, on the captured site. */
function pageAt(memory: ToolMemory, tab: ConfluenceTab, at: PageTarget): PageReference {
  if (typeof at !== 'string') {
    requirePage(memory, at)
    return at
  }
  const linked = linkedPage(tab, at)
  if (!linked) throw new Error('Use a link to a published page on the Confluence site in the current tab.')
  return linked
}

/** The page a call names, or `undefined` for the page open in the tab. */
function resolvePage(memory: ToolMemory, tab: ConfluenceTab, at: PageTarget | undefined): PageReference | undefined {
  return at === undefined ? undefined : pageAt(memory, tab, at)
}

async function requireSameTab(captured: ConfluenceTab): Promise<void> {
  const now = await captureConfluenceTab()
  if (
    now?.tabId !== captured.tabId ||
    now.url !== captured.url ||
    now.instance.path !== captured.instance.path ||
    now.instance.origin !== captured.instance.origin
  )
    refuse('The Confluence tab changed. Open the intended page and ask again.')
}

/**
 * A write, as a preview the user sees and the run that applies it: both are bound to the question
 * and the tab it was asked on. The preview reads what the write needs; the run checks it again first.
 */
function change<S extends z.ZodObject>(
  name: string,
  title: string,
  description: string,
  args: S,
  prepare: (
    input: z.output<S>,
    context: ToolContext<ToolMemory>,
    tab: ConfluenceTab,
    signal?: AbortSignal,
  ) => Promise<Plan>,
) {
  const plans = new WeakMap<ConfluenceQuestion, { tab: ConfluenceTab; plan: Plan } | { error: Error }>()
  return defineTool({
    name,
    description,
    args,
    changesData: true,
    needsConfirmation: ({ memory }) => {
      const question = memory.confluenceQuestion
      const pending = question && plans.get(question)
      return pending !== undefined && 'plan' in pending && pending.plan.confirm === true
    },
    describe: () => on(verb('change', 'changing', 'changed'), undefined, title),
    preview: async (input, context, signal) => {
      const { memory } = context
      const question = memory.confluenceQuestion
      if (!question) refuse('Ask for a Confluence change from the side panel.')
      plans.delete(question)
      let tab: ConfluenceTab
      try {
        tab = await target(context)
      } catch (error) {
        // Not a Confluence page, or a site the user did not allow: the run tells the model.
        if (!(error instanceof Error) || 'stopsQuestion' in error) throw error
        plans.set(question, { error })
        return undefined
      }
      await requireSameTab(tab)
      signal?.throwIfAborted()
      try {
        const plan = await prepare(input, context, tab, signal)
        signal?.throwIfAborted()
        if (memory.confluenceQuestion !== question) return undefined
        plans.set(question, { tab, plan })
        return plan.preview
      } catch (error) {
        if (!(error instanceof Error) || 'stopsQuestion' in error || signal?.aborted) throw error
        plans.set(question, { error })
        return undefined
      }
    },
    run: async (_args, signal, { memory }) => {
      const question = memory.confluenceQuestion
      const prepared = question && plans.get(question)
      if (!question || !prepared) refuse('Ask again to review the intended Confluence change.')
      plans.delete(question)
      if ('error' in prepared) throw prepared.error
      const { plan, tab } = prepared
      signal?.throwIfAborted()
      await requireSameTab(tab)
      signal?.throwIfAborted()
      const result = await plan.apply(signal)
      return { text: asData([JSON.stringify(result.data)]), details: {}, changed: result.changed }
    },
  })
}

async function planPageWrite(tab: ConfluenceTab, write: PageWriteRequest, signal?: AbortSignal): Promise<Plan> {
  if (tab.instance.cloud) {
    const plan = await prepareCloudPageWrite(write, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        const data = await plan.apply(signal)
        return { data, changed: data.changed }
      },
    }
  }
  const plan = await preparePageWrite(write, tab, signal)
  return {
    preview: describePageWrite(plan),
    async apply(signal) {
      const data = await applyPageWrite(plan, signal)
      return { data, changed: data.changed }
    },
  }
}

const createPage = change(
  'create_page',
  'a Confluence page',
  'Create a published child page under a page on the Confluence site in the current tab, with a title and plain-text ' +
    'body. Blank lines separate paragraphs. A page with the same title in the space is left as it is.',
  z.strictObject({
    title: title.describe('The title of the new page, unique in its space.'),
    text: z.string().max(40_000).optional().describe('The body, as plain text. Omit for an empty page.'),
    parent: page.describe(
      'The parent page: a page reference returned by a Confluence tool in this question, or a link to a page on this Confluence site. Omit for the page open in the current tab.',
    ),
  }),
  ({ title, text, parent }, { memory }, tab, signal) =>
    planPageWrite(tab, { action: 'create', title, text: text ?? '', parent: resolvePage(memory, tab, parent) }, signal),
)

const renamePage = change(
  'rename_page',
  'a Confluence page',
  'Change the title of a published page. Its body and place stay as they are.',
  z.strictObject({ title: title.describe('The new title, unique in the space.'), page }),
  ({ title, page }, { memory }, tab, signal) =>
    planPageWrite(tab, { action: 'rename', title, page: resolvePage(memory, tab, page) }, signal),
)

const passage = z
  .string()
  .max(2000)
  .regex(/^[^\p{Cc}]*$/u, 'Use text on one line, with no control characters.')
const editPage = change(
  'edit_page',
  'text on a Confluence page',
  "Replace one passage of a published page's text with new text, keeping the rest of the page and its formatting. " +
    'The passage must appear once, within one paragraph or cell: read the page first and quote its current text.',
  z
    .strictObject({
      before: passage
        .refine((text) => text.trim().length > 0, 'Quote a passage.')
        .describe('The exact text to replace.'),
      after: passage.describe('The text that replaces it; empty to delete it.'),
      page,
    })
    .refine(({ before, after }) => before !== after, 'The replacement is the same as the passage.'),
  async ({ before, after, page }, { memory }, tab, signal) => {
    const request = { before, after, page: resolvePage(memory, tab, page) }
    const plan = tab.instance.cloud
      ? await prepareCloudPageEdit(request, tab, signal)
      : await preparePageEdit(request, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        const data = 'apply' in plan ? await plan.apply(signal) : await applyPageEdit(plan, signal)
        return { data, changed: true }
      },
    }
  },
)

const trashPage = change(
  'trash_page',
  'the status of a Confluence page',
  "Move a published page with no child pages to the space's recoverable trash. The user is asked first, each time. " +
    'Trash only pages the user asked to remove.',
  z.strictObject({ page }),
  async ({ page }, { memory }, tab, signal) => {
    const at = resolvePage(memory, tab, page)
    if (tab.instance.cloud) {
      const plan = await prepareCloudTrash(tab, at, signal)
      return {
        preview: plan.preview,
        confirm: true,
        async apply(signal) {
          const data = await plan.apply(signal)
          return { data, changed: data.changed }
        },
      }
    }
    const plan = await preparePageTrash(at, tab, signal)
    return {
      preview: plan.preview,
      confirm: plan.page.status !== 'trashed',
      async apply(signal) {
        const data = await applyPageTrash(plan, signal)
        return { data, changed: data.changed }
      },
    }
  },
)

const parent = pageTarget.describe(
  'The new parent page, in the same space: a page reference returned by a Confluence tool in this question, or a link to a page on this Confluence site.',
)

async function planOrganization(tab: ConfluenceTab, request: OrganizationRequest, signal?: AbortSignal): Promise<Plan> {
  if (tab.instance.cloud) {
    const plan = await prepareCloudOrganization(request, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        const data = await plan.apply(signal)
        return { data, changed: data.changed }
      },
    }
  }
  const plan = await prepareOrganization(request, tab, signal)
  return {
    preview: plan.preview,
    async apply(signal) {
      const data = await applyOrganization(plan, signal)
      return { data, changed: data.changed }
    },
  }
}

const movePage = change(
  'move_page',
  'a Confluence page',
  'Move a published page, with its children, under another page in the same space.',
  z.strictObject({ page, parent }),
  ({ page, parent }, { memory }, tab, signal) =>
    planOrganization(
      tab,
      { action: 'move', page: resolvePage(memory, tab, page), parent: pageAt(memory, tab, parent) },
      signal,
    ),
)

const copyPage = change(
  'copy_page',
  'a Confluence page',
  "Copy a published page's body as a new page under a page in the same space, with its own title. Pages with " +
    'attachments or inline comments are not copied.',
  z.strictObject({ page, parent, title: title.describe('The title of the copy, unique in the space.') }),
  ({ page, parent, title }, { memory }, tab, signal) =>
    planOrganization(
      tab,
      { action: 'copy', title, page: resolvePage(memory, tab, page), parent: pageAt(memory, tab, parent) },
      signal,
    ),
)

const changeLabel = change(
  'change_page_label',
  'a Confluence page label',
  'Add or remove an ordinary label on a published page.',
  z.strictObject({
    action: z.enum(['add', 'remove']),
    label: labelName.describe('The label, without a prefix or spaces.'),
    page,
  }),
  async ({ action, label, page }, { memory }, tab) => {
    const request = { action, label: label.toLowerCase(), page: resolvePage(memory, tab, page) }
    return {
      preview: `${action === 'add' ? 'Add' : 'Remove'} the label "${request.label}" ${action === 'add' ? 'to' : 'from'} the page.`,
      async apply(signal) {
        const data = tab.instance.cloud
          ? await applyCloudLabel(request, tab, signal)
          : await applyLabel(request, tab, signal)
        return { data, changed: data.changed }
      },
    }
  },
)

const addComment = change(
  'add_page_comment',
  'a Confluence page comment',
  "Post a footer comment on a published page, or a reply to one of its footer comments. The page's watchers are " +
    'notified, so comment only when the user asks for it.',
  z.strictObject({
    text: z
      .string()
      .max(4000)
      .refine((text) => text.trim().length > 0, 'Write a comment.')
      .describe('The comment, as plain text.'),
    page,
    replyTo: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe('The id of the footer comment to reply to, from list_page_comments. Omit for a new comment.'),
  }),
  async ({ text, page, replyTo }, { memory }, tab, signal) => {
    const request = { text, page: resolvePage(memory, tab, page), parentId: replyTo }
    if (tab.instance.cloud) {
      const plan = await prepareCloudComment(request, tab, signal)
      return {
        preview: plan.preview,
        async apply(signal) {
          return { data: await plan.apply(signal), changed: true }
        },
      }
    }
    const plan = await prepareComment(request, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        return { data: await applyComment(plan, signal), changed: true }
      },
    }
  },
)

export const CONFLUENCE_WRITES = [
  createPage,
  renamePage,
  changeLabel,
  addComment,
  editPage,
  trashPage,
  movePage,
  copyPage,
]
